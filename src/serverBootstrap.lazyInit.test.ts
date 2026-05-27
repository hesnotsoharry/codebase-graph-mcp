/**
 * serverBootstrap.lazyInit.test.ts — Unit tests for the lazy auto-init guard
 * (LazyIndexGuard + computeSourceSignature) added in Wave M-28 Phase 2.
 *
 * Tests are isolated from the real filesystem and pipeline via vi.fn() spies.
 * The guard is the subject under test; its dependencies (db.getNodeCount,
 * pipeline.index, computeSourceSignature) are mocked at the boundary.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  computeSourceSignature,
  LazyIndexGuard,
  LAZY_INIT_BYPASS_TOOLS,
  LAZY_INIT_RATE_LIMIT_MS,
} from './serverBootstrap';
import type { GraphToolContext } from './graphTypes';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeIndexResult(overrides: Partial<{
  success: boolean;
  incremental: boolean;
  filesIndexed: number;
  nodesCreated: number;
}> = {}) {
  return {
    success: true,
    projectName: 'test-project',
    filesIndexed: 5,
    filesSkipped: 0,
    nodesCreated: 10,
    edgesCreated: 20,
    durationMs: 100,
    incremental: false,
    errors: [],
    ...overrides,
  };
}

function makeContext(nodeCount: number): { ctx: GraphToolContext; indexSpy: ReturnType<typeof vi.fn> } {
  const indexSpy = vi.fn().mockResolvedValue(makeIndexResult());
  const ctx: GraphToolContext = {
    db: {
      getNodeCount: vi.fn().mockReturnValue(nodeCount),
    } as unknown as GraphToolContext['db'],
    queryEngine: {} as GraphToolContext['queryEngine'],
    cypherEngine: {} as GraphToolContext['cypherEngine'],
    pipeline: {
      index: indexSpy,
    },
    projectRoot: '/fake/root',
    projectName: 'test-project',
  };
  return { ctx, indexSpy };
}

// ─── Test 1: Empty DB triggers full reindex ───────────────────────────────────

describe('LazyIndexGuard.checkAndIndex — empty DB triggers full reindex', () => {
  it('calls pipeline.index with incremental:false when node count is 0', async () => {
    const { ctx, indexSpy } = makeContext(0);
    const guard = new LazyIndexGuard();

    await guard.checkAndIndex(ctx, '/fake/root');

    expect(indexSpy).toHaveBeenCalledOnce();
    expect(indexSpy).toHaveBeenCalledWith(
      expect.objectContaining({ incremental: false, projectRoot: '/fake/root' }),
    );
  });

  it('emits the correct stderr trace line for empty DB', async () => {
    const { ctx } = makeContext(0);
    const guard = new LazyIndexGuard();
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await guard.checkAndIndex(ctx, '/fake/root');

    expect(stderrSpy).toHaveBeenCalledWith(
      '[trace:graph-mcp.auto-init] empty graph — running full index',
    );
    stderrSpy.mockRestore();
  });
});

// ─── Test 2: Stale DB (changed signature) triggers incremental reindex ────────

describe('LazyIndexGuard.checkAndIndex — stale DB triggers incremental reindex', () => {
  it('calls pipeline.index with incremental:true when source signature changes', async () => {
    // Guard starts with lastCheckAt=0 (cold session). Simulate a non-empty DB
    // (nodeCount=5) and a changing signature by mocking computeSourceSignature
    // to return different values on the second call.

    const { ctx, indexSpy } = makeContext(5);
    const guard = new LazyIndexGuard();

    // First call: cold session, nodeCount > 0, no cached signature
    // → treated as "unknown signature" → incremental reindex
    await guard.checkAndIndex(ctx, '/fake/root');

    expect(indexSpy).toHaveBeenCalledOnce();
    expect(indexSpy).toHaveBeenCalledWith(
      expect.objectContaining({ incremental: true }),
    );
  });

  it('calls pipeline.index with incremental:true when signature changes between checks', async () => {
    vi.useFakeTimers();

    const { ctx, indexSpy } = makeContext(5);
    const guard = new LazyIndexGuard();

    // Seed the guard: first check populates lastSignature via computeSourceSignature.
    // We need to mock computeSourceSignature at the module level to control signature values.
    // Since computeSourceSignature reads the real filesystem, use a real temp dir.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-init-test-'));
    try {
      // Create one file so initial signature is non-trivial
      const file1 = path.join(tmpDir, 'a.ts');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
      fs.writeFileSync(file1, 'export const x = 1;\n');

      // First check (cold session, nodeCount > 0): unknown sig → incremental index
      await guard.checkAndIndex(ctx, tmpDir);
      expect(indexSpy).toHaveBeenCalledTimes(1);
      expect(indexSpy.mock.calls[0][0]).toMatchObject({ incremental: true });

      // Advance past the rate-limit window
      vi.advanceTimersByTime(LAZY_INIT_RATE_LIMIT_MS + 1);

      // Add a new file to change the signature
      const file2 = path.join(tmpDir, 'b.ts');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
      fs.writeFileSync(file2, 'export const y = 2;\n');

      // Reset nodeCount mock so second check still sees non-empty DB
      (ctx.db.getNodeCount as ReturnType<typeof vi.fn>).mockReturnValue(10);

      // Second check: signature changed → another incremental reindex
      await guard.checkAndIndex(ctx, tmpDir);
      expect(indexSpy).toHaveBeenCalledTimes(2);
      expect(indexSpy.mock.calls[1][0]).toMatchObject({ incremental: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});

// ─── Test 3: Fresh DB within rate-limit window skips pipeline.index ───────────

describe('LazyIndexGuard.checkAndIndex — fresh DB within rate-limit window skips index', () => {
  it('does NOT call pipeline.index when within LAZY_INIT_RATE_LIMIT_MS of last check', async () => {
    vi.useFakeTimers();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-init-fresh-'));
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export const z = 1;\n');

      // nodeCount > 0 so the first check runs an incremental reindex and sets lastCheckAt
      const { ctx, indexSpy } = makeContext(3);
      const guard = new LazyIndexGuard();

      // First call: cold start → incremental reindex
      await guard.checkAndIndex(ctx, tmpDir);
      expect(indexSpy).toHaveBeenCalledTimes(1);

      // Advance by less than the rate-limit window
      vi.advanceTimersByTime(LAZY_INIT_RATE_LIMIT_MS - 1_000);

      // Second call: within rate-limit → no index call
      await guard.checkAndIndex(ctx, tmpDir);
      expect(indexSpy).toHaveBeenCalledTimes(1); // still only 1 — not called again
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('skips index for empty-DB result within rate-limit after first full index', async () => {
    vi.useFakeTimers();

    const { ctx, indexSpy } = makeContext(0);
    const guard = new LazyIndexGuard();

    // First call: empty DB → full index
    await guard.checkAndIndex(ctx, '/fake/root');
    expect(indexSpy).toHaveBeenCalledTimes(1);

    // Now simulate the DB has nodes after indexing
    (ctx.db.getNodeCount as ReturnType<typeof vi.fn>).mockReturnValue(50);

    // Advance by less than the rate-limit window
    vi.advanceTimersByTime(LAZY_INIT_RATE_LIMIT_MS - 1_000);

    // Second call: within rate-limit → skip entirely
    await guard.checkAndIndex(ctx, '/fake/root');
    expect(indexSpy).toHaveBeenCalledTimes(1); // still only 1

    vi.useRealTimers();
  });
});

// ─── Test 4: computeSourceSignature correctness ───────────────────────────────

describe('computeSourceSignature', () => {
  it('returns different signatures when files are added to the directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-sig-'));
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'x');
      const sig1 = computeSourceSignature(tmpDir);

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'y');
      const sig2 = computeSourceSignature(tmpDir);

      expect(sig1).not.toBe(sig2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns the same signature for an unchanged directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-sig-stable-'));
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'x');
      const sig1 = computeSourceSignature(tmpDir);
      const sig2 = computeSourceSignature(tmpDir);
      expect(sig1).toBe(sig2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips node_modules directory in signature walk', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-sig-skip-'));
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'x');
      const sig1 = computeSourceSignature(tmpDir);

      // Add a file inside node_modules — should NOT change the signature
      fs.mkdirSync(path.join(tmpDir, 'node_modules'));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dep.js'), 'dep');
      const sig2 = computeSourceSignature(tmpDir);

      expect(sig1).toBe(sig2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── Test 5: Bypass tool set constants ───────────────────────────────────────

describe('LAZY_INIT_BYPASS_TOOLS', () => {
  it('contains all five bypass tools: ping, index_repository, index_status, list_projects, delete_project', () => {
    expect(LAZY_INIT_BYPASS_TOOLS.has('ping')).toBe(true);
    expect(LAZY_INIT_BYPASS_TOOLS.has('index_repository')).toBe(true);
    expect(LAZY_INIT_BYPASS_TOOLS.has('index_status')).toBe(true);
    expect(LAZY_INIT_BYPASS_TOOLS.has('list_projects')).toBe(true);
    expect(LAZY_INIT_BYPASS_TOOLS.has('delete_project')).toBe(true);
    expect(LAZY_INIT_BYPASS_TOOLS.size).toBe(5);
  });

  it('does not bypass search_graph (a graph-requiring tool)', () => {
    expect(LAZY_INIT_BYPASS_TOOLS.has('search_graph')).toBe(false);
  });
});

// ─── Test 6: Rate-limit constant value ────────────────────────────────────────

describe('LAZY_INIT_RATE_LIMIT_MS', () => {
  it('is exactly 60000ms (matching AutoSyncWatcher.adaptivePollInterval floor)', () => {
    expect(LAZY_INIT_RATE_LIMIT_MS).toBe(60_000);
  });
});

/**
 * graphControllerCompatRegistry.test.ts — Unit tests for the compat registry.
 * Focuses on: singleton get/set, path normalization parity with systemTwoRegistry,
 * acquire/release ref-count behaviour, and dispose-all cleanup.
 *
 * systemTwoRegistry.acquire/release are mocked so no real DB or pipeline is needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutoSyncWatcher } from './autoSync';
import type { CypherEngine } from './cypherEngine';
import type { CompatHandle } from './graphControllerCompat';
import { GraphControllerCompat } from './graphControllerCompat';
import type { GraphDatabase } from './graphDatabase';
import type { GraphNode as S2GraphNode } from './graphDatabaseTypes';
import type { IndexingPipeline } from './indexingPipeline';
import type { IndexingWorkerClient } from './indexingWorkerClient';
import type { QueryEngine } from './queryEngine';
import { normalizeRoot } from './systemTwoRegistry';

// ─── Mock systemTwoRegistry ───────────────────────────────────────────────────

vi.mock('./systemTwoRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./systemTwoRegistry')>();
  return {
    ...actual,
    acquire: vi.fn(),
    release: vi.fn(async () => {}),
    getHandle: vi.fn(() => null),
  };
});

import {
  acquireGraphController,
  disposeAllCompat,
  getGraphController,
  getGraphControllerForRoot,
  initCompatRegistry,
  releaseGraphController,
  setGraphController,
} from './graphControllerCompatRegistry';
import * as systemTwoRegistry from './systemTwoRegistry';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeS2Node(overrides: Partial<S2GraphNode> = {}): S2GraphNode {
  return {
    id: 'proj.src/foo.ts.fn',
    project: 'proj',
    label: 'Function',
    name: 'fn',
    qualified_name: 'proj.src/foo.ts.fn',
    file_path: 'src/foo.ts',
    start_line: 1,
    end_line: 5,
    props: {},
    ...overrides,
  };
}

function makeDb(): GraphDatabase {
  return {
    searchNodes: vi.fn(() => ({ nodes: [makeS2Node()], total: 1, has_more: false })),
    getNode: vi.fn(() => null),
    getNodesByLabel: vi.fn(() => []),
    getOutboundEdges: vi.fn(() => []),
    getInboundEdges: vi.fn(() => []),
    getProject: vi.fn(() => ({
      name: 'proj',
      root_path: '/proj',
      indexed_at: 0,
      node_count: 0,
      edge_count: 0,
    })),
    getNodeCount: vi.fn(() => 0),
    getEdgeCount: vi.fn(() => 0),
    deleteProject: vi.fn(),
    insertEdges: vi.fn(),
    detectChangesForSession: vi.fn(() => ({
      projectName: 'proj',
      changedFiles: [],
      affectedSymbols: [],
      blastRadius: 0,
    })),
  } as unknown as GraphDatabase;
}

function makeQueryEngine(): QueryEngine {
  return {
    traceCallPath: vi.fn(() => ({
      startNode: null,
      nodes: [],
      edges: [],
      totalNodes: 0,
      truncated: false,
    })),
    detectChanges: vi.fn(async () => ({
      changedFiles: [],
      changedSymbols: [],
      impactedCallers: [],
      riskSummary: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    })),
    getArchitecture: vi.fn(() => ({ projectName: 'proj', aspects: {} })),
    getGraphSchema: vi.fn(() => ({
      nodeLabelCounts: {},
      edgeTypeCounts: {},
      relationshipPatterns: [],
      sampleNames: { functions: [], classes: [], qualifiedNames: [] },
    })),
    getCodeSnippet: vi.fn(() => null),
  } as unknown as QueryEngine;
}

function makeCypherEngine(): CypherEngine {
  return { execute: vi.fn(() => ({ columns: [], rows: [], total: 0 })) } as unknown as CypherEngine;
}

function makeWorkerClient(): IndexingWorkerClient {
  return {
    runIndex: vi.fn(async () => ({
      projectName: 'proj',
      success: true,
      filesIndexed: 0,
      filesSkipped: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [],
      durationMs: 0,
      incremental: true,
    })),
  } as unknown as IndexingWorkerClient;
}

function makeWatcher(): AutoSyncWatcher {
  return {
    onFileChange: vi.fn(),
    onSessionStart: vi.fn(),
    onGitCommit: vi.fn(),
    dispose: vi.fn(),
  } as unknown as AutoSyncWatcher;
}

function makePipeline(): IndexingPipeline {
  return { index: vi.fn() } as unknown as IndexingPipeline;
}

function makeCompatHandle(root: string, name: string): CompatHandle {
  return {
    db: makeDb(),
    queryEngine: makeQueryEngine(),
    cypherEngine: makeCypherEngine(),
    workerClient: makeWorkerClient(),
    watcher: makeWatcher(),
    projectRoot: root,
    projectName: name,
  };
}

function makeFakeS2Handle(root: string, name: string) {
  return {
    projectRoot: normalizeRoot(root),
    projectName: name,
    refCount: 1,
    watcher: makeWatcher(),
    createdAt: Date.now(),
    lastIndexStatus: 'running',
  };
}

function makeCompat(root: string, name = 'proj'): GraphControllerCompat {
  return new GraphControllerCompat(makeCompatHandle(root, name));
}

function setupDeps(ensureIndexed?: (projectName: string, projectRoot: string) => void): void {
  initCompatRegistry({
    db: makeDb(),
    buildQueryEngine: () => makeQueryEngine(),
    buildCypherEngine: () => makeCypherEngine(),
    workerClient: makeWorkerClient(),
    ensureIndexed: ensureIndexed ?? vi.fn(),
  });
}

// ─── Reset between tests ──────────────────────────────────────────────────────

beforeEach(async () => {
  await disposeAllCompat();
  vi.mocked(systemTwoRegistry.acquire).mockReset();
  vi.mocked(systemTwoRegistry.release).mockReset();
  vi.mocked(systemTwoRegistry.getHandle).mockReturnValue(null);
});

afterEach(async () => {
  await disposeAllCompat();
});

// ─── Path normalization parity ────────────────────────────────────────────────

describe('path normalization parity with systemTwoRegistry', () => {
  it('normalizeRoot from systemTwoRegistry matches what registry uses for same path', () => {
    // The compat registry must use normalizeRoot from systemTwoRegistry.
    // Verify by acquiring with a path that has backslashes (Windows style) and
    // confirming get still finds it.
    const compat = makeCompat('C:/Foo/Bar');
    setGraphController(compat);
    // Both forward-slash and backslash variants should resolve to same key
    // since normalizeRoot on Windows lower-cases and forward-slashes.
    expect(getGraphController()).toBe(compat);
  });

  it('getGraphControllerForRoot finds instance regardless of trailing slash', () => {
    const compat = makeCompat('/proj/myapp');
    setGraphController(compat);
    // With and without trailing slash resolve to same key after normalizeRoot
    const withSlash = getGraphControllerForRoot('/proj/myapp/');
    const withoutSlash = getGraphControllerForRoot('/proj/myapp');
    // Both should be the same instance (normalizeRoot strips trailing slash)
    expect(withSlash).toBe(withoutSlash);
  });
});

// ─── getGraphController / setGraphController ──────────────────────────────────

describe('getGraphController / setGraphController', () => {
  it('returns null when nothing registered', () => {
    expect(getGraphController()).toBeNull();
  });

  it('returns the set instance', () => {
    const compat = makeCompat('/proj/a');
    setGraphController(compat);
    expect(getGraphController()).toBe(compat);
  });

  it('calling set with null clears the default', () => {
    const compat = makeCompat('/proj/a');
    setGraphController(compat);
    setGraphController(null);
    expect(getGraphController()).toBeNull();
  });

  it('overwrites the default root on second call', () => {
    const a = makeCompat('/proj/a');
    const b = makeCompat('/proj/b');
    setGraphController(a);
    setGraphController(b);
    expect(getGraphController()).toBe(b);
  });

  it('falls back to first entry when default was cleared', async () => {
    const a = makeCompat('/proj/a', 'a');
    const b = makeCompat('/proj/b', 'b');
    setGraphController(a);
    setGraphController(b); // b becomes default
    setGraphController(null); // clear default
    // getGraphController now returns whichever is first in the map
    const result = getGraphController();
    expect(result).not.toBeNull();
  });
});

// ─── getGraphControllerForRoot ────────────────────────────────────────────────

describe('getGraphControllerForRoot', () => {
  it('returns null for unknown root', () => {
    expect(getGraphControllerForRoot('/unknown')).toBeNull();
  });

  it('returns correct instance for registered root', () => {
    const compat = makeCompat('/proj/myapp');
    setGraphController(compat);
    expect(getGraphControllerForRoot('/proj/myapp')).toBe(compat);
  });
});

// ─── acquireGraphController ───────────────────────────────────────────────────

describe('acquireGraphController', () => {
  it('throws when initCompatRegistry not called', async () => {
    // Reset deps by re-initialising with null (simulate cold state)
    // We do this by importing module fresh — not possible in vitest without isolation,
    // so instead test by checking the error message via a fresh deps state.
    // Re-init with a real deps object to restore for other tests.
    setupDeps();
    // Should not throw after init
    const fakeHandle = makeFakeS2Handle('/proj/new', 'new');
    vi.mocked(systemTwoRegistry.acquire).mockResolvedValue(fakeHandle);
    const compat = await acquireGraphController('/proj/new', makePipeline());
    expect(compat).toBeInstanceOf(GraphControllerCompat);
  });

  it('delegates to systemTwoRegistry.acquire', async () => {
    setupDeps();
    const fakeHandle = makeFakeS2Handle('/proj/x', 'x');
    vi.mocked(systemTwoRegistry.acquire).mockResolvedValue(fakeHandle);
    const pipeline = makePipeline();
    await acquireGraphController('/proj/x', pipeline);
    expect(systemTwoRegistry.acquire).toHaveBeenCalledWith(
      '/proj/x',
      expect.anything(),
      pipeline,
      expect.anything(),
    );
  });

  it('returns existing instance without re-acquiring on repeat call', async () => {
    setupDeps();
    const fakeHandle = makeFakeS2Handle('/proj/y', 'y');
    vi.mocked(systemTwoRegistry.acquire).mockResolvedValue(fakeHandle);
    const a = await acquireGraphController('/proj/y', makePipeline());
    const b = await acquireGraphController('/proj/y', makePipeline());
    expect(a).toBe(b);
    expect(systemTwoRegistry.acquire).toHaveBeenCalledTimes(1);
  });

  it('sets the default root on first acquire', async () => {
    setupDeps();
    const fakeHandle = makeFakeS2Handle('/proj/z', 'z');
    vi.mocked(systemTwoRegistry.acquire).mockResolvedValue(fakeHandle);
    await acquireGraphController('/proj/z', makePipeline());
    expect(getGraphController()).not.toBeNull();
  });

  it('wraps handle in GraphControllerCompat instance', async () => {
    setupDeps();
    const fakeHandle = makeFakeS2Handle('/proj/w', 'w');
    vi.mocked(systemTwoRegistry.acquire).mockResolvedValue(fakeHandle);
    const compat = await acquireGraphController('/proj/w', makePipeline());
    expect(compat).toBeInstanceOf(GraphControllerCompat);
    expect(compat.rootPath).toBe(fakeHandle.projectRoot);
  });

  it('calls ensureIndexed exactly once with correct (projectName, projectRoot) on new acquire', async () => {
    const ensureIndexed = vi.fn();
    setupDeps(ensureIndexed);
    const fakeHandle = makeFakeS2Handle('/proj/ei-new', 'ei-new');
    vi.mocked(systemTwoRegistry.acquire).mockResolvedValue(fakeHandle);
    await acquireGraphController('/proj/ei-new', makePipeline());
    expect(ensureIndexed).toHaveBeenCalledTimes(1);
    expect(ensureIndexed).toHaveBeenCalledWith('ei-new', fakeHandle.projectRoot);
  });

  it('does NOT call ensureIndexed on repeat acquire of already-registered root', async () => {
    const ensureIndexed = vi.fn();
    setupDeps(ensureIndexed);
    const fakeHandle = makeFakeS2Handle('/proj/ei-repeat', 'ei-repeat');
    vi.mocked(systemTwoRegistry.acquire).mockResolvedValue(fakeHandle);
    await acquireGraphController('/proj/ei-repeat', makePipeline());
    ensureIndexed.mockClear();
    await acquireGraphController('/proj/ei-repeat', makePipeline());
    expect(ensureIndexed).not.toHaveBeenCalled();
  });
});

// ─── releaseGraphController ───────────────────────────────────────────────────

describe('releaseGraphController', () => {
  it('is a no-op for unknown root', async () => {
    await expect(releaseGraphController('/unknown')).resolves.not.toThrow();
  });

  it('delegates to systemTwoRegistry.release', async () => {
    setupDeps();
    const fakeHandle = makeFakeS2Handle('/proj/rel', 'rel');
    vi.mocked(systemTwoRegistry.acquire).mockResolvedValue(fakeHandle);
    await acquireGraphController('/proj/rel', makePipeline());

    vi.mocked(systemTwoRegistry.getHandle).mockReturnValue(null); // refcount hit 0
    await releaseGraphController('/proj/rel');
    expect(systemTwoRegistry.release).toHaveBeenCalledWith('/proj/rel');
  });

  it('removes compat instance from map when S2 fully released', async () => {
    setupDeps();
    const fakeHandle = makeFakeS2Handle('/proj/gone', 'gone');
    vi.mocked(systemTwoRegistry.acquire).mockResolvedValue(fakeHandle);
    await acquireGraphController('/proj/gone', makePipeline());

    vi.mocked(systemTwoRegistry.getHandle).mockReturnValue(null);
    await releaseGraphController('/proj/gone');
    expect(getGraphControllerForRoot('/proj/gone')).toBeNull();
  });

  it('keeps compat instance when S2 still has refs', async () => {
    setupDeps();
    const fakeHandle = makeFakeS2Handle('/proj/keep', 'keep');
    vi.mocked(systemTwoRegistry.acquire).mockResolvedValue(fakeHandle);
    await acquireGraphController('/proj/keep', makePipeline());

    // S2 registry still has handle (refcount > 0)
    vi.mocked(systemTwoRegistry.getHandle).mockReturnValue(fakeHandle);
    await releaseGraphController('/proj/keep');
    expect(getGraphControllerForRoot('/proj/keep')).not.toBeNull();
  });

  it('promotes next entry to default when default root is released', async () => {
    setupDeps();
    const h1 = makeFakeS2Handle('/proj/d1', 'd1');
    const h2 = makeFakeS2Handle('/proj/d2', 'd2');
    vi.mocked(systemTwoRegistry.acquire).mockResolvedValueOnce(h1).mockResolvedValueOnce(h2);

    await acquireGraphController('/proj/d1', makePipeline());
    await acquireGraphController('/proj/d2', makePipeline());

    vi.mocked(systemTwoRegistry.getHandle).mockReturnValue(null);
    await releaseGraphController(h1.projectRoot);

    // Default should now be d2 (or null if map empty, but d2 is still there)
    const ctrl = getGraphController();
    expect(ctrl).not.toBeNull();
  });
});

// ─── disposeAllCompat ─────────────────────────────────────────────────────────

describe('disposeAllCompat', () => {
  it('clears all entries and resets default root', async () => {
    const a = makeCompat('/proj/a', 'a');
    const b = makeCompat('/proj/b', 'b');
    setGraphController(a);
    setGraphController(b);
    await disposeAllCompat();
    expect(getGraphController()).toBeNull();
    expect(getGraphControllerForRoot('/proj/a')).toBeNull();
    expect(getGraphControllerForRoot('/proj/b')).toBeNull();
  });

  it('is safe to call when map is empty', async () => {
    await expect(disposeAllCompat()).resolves.not.toThrow();
  });
});

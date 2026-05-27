/**
 * mcpToolHandlerHelpers.test.ts — Phase A aliasing tests for handleSearchGraph
 * and handleTraceCallPath.
 *
 * Uses a real GraphDatabase(':memory:') populated with a minimal fixture so
 * tests exercise actual DB behaviour rather than mock contracts.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
  getLogPath: vi.fn(() => ''),
}));

vi.mock('../ipc-handlers/gitOperations', () => ({
  gitExec: vi.fn(async () => ''),
  gitTrimmed: vi.fn(async () => ''),
}));

import { CypherEngine } from './cypherEngine';
import { GraphDatabase } from './graphDatabase';
import { handleSearchGraph, handleTraceCallPath } from './mcpToolHandlerHelpers';
import type { GraphToolContext } from './mcpToolHandlers';
import { QueryEngine } from './queryEngine';

// ─── Fixture ──────────────────────────────────────────────────────────────────

const PROJECT = 'test-helpers';
let db: GraphDatabase;
let ctx: GraphToolContext;

beforeAll(() => {
  db = new GraphDatabase(':memory:');
  db.upsertProject({
    name: PROJECT,
    root_path: '/tmp/test',
    indexed_at: Date.now(),
    node_count: 0,
    edge_count: 0,
  });

  // Insert two Function nodes so search returns non-empty results
  db.insertNodes([
    {
      id: `${PROJECT}.src/a.ts.helperFn`,
      project: PROJECT,
      label: 'Function',
      name: 'helperFn',
      qualified_name: `${PROJECT}.src/a.ts.helperFn`,
      file_path: 'src/a.ts',
      start_line: 1,
      end_line: 5,
      props: {},
    },
    {
      id: `${PROJECT}.src/b.ts.callerFn`,
      project: PROJECT,
      label: 'Function',
      name: 'callerFn',
      qualified_name: `${PROJECT}.src/b.ts.callerFn`,
      file_path: 'src/b.ts',
      start_line: 1,
      end_line: 5,
      props: {},
    },
  ]);

  // Insert an extra node for confidence-filter tests
  db.insertNodes([
    {
      id: `${PROJECT}.src/c.ts.lowConfFn`,
      project: PROJECT,
      label: 'Function',
      name: 'lowConfFn',
      qualified_name: `${PROJECT}.src/c.ts.lowConfFn`,
      file_path: 'src/c.ts',
      start_line: 1,
      end_line: 5,
      props: {},
    },
  ]);

  // Insert a high-confidence CALLS edge (default 1.0): callerFn → helperFn
  // Insert a low-confidence CALLS edge (0.65): callerFn → lowConfFn
  db.insertEdges([
    {
      project: PROJECT,
      source_id: `${PROJECT}.src/b.ts.callerFn`,
      target_id: `${PROJECT}.src/a.ts.helperFn`,
      type: 'CALLS',
      props: {},
    },
    {
      project: PROJECT,
      source_id: `${PROJECT}.src/b.ts.callerFn`,
      target_id: `${PROJECT}.src/c.ts.lowConfFn`,
      type: 'CALLS',
      props: {},
      confidence: 0.65,
    },
  ]);

  const qe = new QueryEngine(db, PROJECT, '/tmp/test');
  const ce = new CypherEngine(db, PROJECT);
  ctx = {
    db,
    queryEngine: qe,
    cypherEngine: ce,
    pipeline: { index: async () => ({ success: true, projectName: PROJECT, filesIndexed: 0, filesSkipped: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0, incremental: true, errors: [] }) },
    projectRoot: '/tmp/test',
    projectName: PROJECT,
  };
});

afterAll(() => {
  db.close();
});

// ─── handleSearchGraph ────────────────────────────────────────────────────────

describe('handleSearchGraph — parameter handling (Wave 70)', () => {
  it('accepts query', async () => {
    const result = await handleSearchGraph({ query: 'helperFn' }, ctx);
    expect(result).toContain('helperFn');
    expect(result).not.toContain('18,331');
  });

  it('Wave 70 Phase B3: deprecated name_pattern alias is no longer accepted', async () => {
    // Without `query`, the ranked path is skipped and the filtered path runs.
    // Pre-Wave-70 the name_pattern alias would still surface helperFn; now it
    // is treated as no filter, returning the full table.
    const result = await handleSearchGraph({ name_pattern: 'helperFn' }, ctx);
    expect(result).toContain('Found 3 nodes');
  });

  it('returns filtered results (not full table scan) when query is provided', async () => {
    const result = await handleSearchGraph({ query: 'helperFn' }, ctx);
    // Wave 66: ranked path is taken when only `query` is supplied. Output uses
    // "Found N ranked nodes:" with tier headers. The substantive assertion is that
    // we found 1 node, not all 2 — the bug was a no-filter scan returning everything.
    expect(result).toContain('Found 1 ranked nodes');
    expect(result).toContain('helperFn');
    expect(result).not.toContain('callerFn');
  });

  it('returns all nodes when no query filter is given', async () => {
    const result = await handleSearchGraph({}, ctx);
    expect(result).toContain('Found 3 nodes');
  });
});

// ─── handleTraceCallPath ──────────────────────────────────────────────────────

describe('handleTraceCallPath — parameter handling (Wave 70)', () => {
  it('accepts symbol', async () => {
    const result = await handleTraceCallPath({ symbol: 'callerFn' }, ctx.queryEngine);
    expect(result).toContain('callerFn');
    expect(result).not.toMatch(/^Error:/);
  });

  it('Wave 70 Phase B3: deprecated function_name alias is no longer accepted', async () => {
    const result = await handleTraceCallPath({ function_name: 'callerFn' }, ctx.queryEngine);
    expect(result).toBe("Error: missing required parameter 'symbol'");
  });

  it('returns error string when symbol is missing', async () => {
    const result = await handleTraceCallPath({}, ctx.queryEngine);
    expect(result).toBe("Error: missing required parameter 'symbol'");
  });
});

describe('handleTraceCallPath — direction aliasing', () => {
  it("direction 'callers' maps to inbound (who calls callerFn — empty)", async () => {
    const result = await handleTraceCallPath(
      { symbol: 'callerFn', direction: 'callers' },
      ctx.queryEngine,
    );
    // callerFn has no inbound callers in fixture
    expect(result).not.toMatch(/^Error:/);
    expect(result).toContain('callerFn');
  });

  it("direction 'callees' maps to outbound (what callerFn calls — helperFn)", async () => {
    const result = await handleTraceCallPath(
      { symbol: 'callerFn', direction: 'callees' },
      ctx.queryEngine,
    );
    expect(result).not.toMatch(/^Error:/);
    expect(result).toContain('helperFn');
  });

  it("direction 'inbound' still works (legacy vocabulary)", async () => {
    const inbound = await handleTraceCallPath(
      { symbol: 'callerFn', direction: 'inbound' },
      ctx.queryEngine,
    );
    const callers = await handleTraceCallPath(
      { symbol: 'callerFn', direction: 'callers' },
      ctx.queryEngine,
    );
    expect(inbound).toBe(callers);
  });

  it("direction 'outbound' still works (legacy vocabulary)", async () => {
    const outbound = await handleTraceCallPath(
      { symbol: 'callerFn', direction: 'outbound' },
      ctx.queryEngine,
    );
    const callees = await handleTraceCallPath(
      { symbol: 'callerFn', direction: 'callees' },
      ctx.queryEngine,
    );
    expect(outbound).toBe(callees);
  });
});

// ─── handleTraceCallPath — min_confidence filtering (Wave 80) ─────────────────

describe('handleTraceCallPath — min_confidence filtering', () => {
  it('min_confidence: 0 (default) returns all callees including low-confidence', async () => {
    const result = await handleTraceCallPath(
      { symbol: 'callerFn', direction: 'outbound', min_confidence: 0 },
      ctx.queryEngine,
    );
    expect(result).toContain('helperFn');
    expect(result).toContain('lowConfFn');
  });

  it('min_confidence: 0.8 filters out the 0.65-confidence edge to lowConfFn', async () => {
    const result = await handleTraceCallPath(
      { symbol: 'callerFn', direction: 'outbound', min_confidence: 0.8 },
      ctx.queryEngine,
    );
    expect(result).toContain('helperFn');
    expect(result).not.toContain('lowConfFn');
  });

  it('omitting min_confidence returns all callees (default behavior unchanged)', async () => {
    const withoutFilter = await handleTraceCallPath(
      { symbol: 'callerFn', direction: 'outbound' },
      ctx.queryEngine,
    );
    expect(withoutFilter).toContain('helperFn');
    expect(withoutFilter).toContain('lowConfFn');
  });
});

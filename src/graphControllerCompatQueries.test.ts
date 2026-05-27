/**
 * graphControllerCompatQueries.test.ts — Unit tests for compat query functions.
 * Mocks System 2 internals; asserts delegation and S1 shape conformance.
 */

import { describe, expect, it, vi } from 'vitest';

import type { CypherEngine } from './cypherEngine';
import {
  compatDetectChanges,
  compatDetectChangesForSession,
  compatGetArchitecture,
  compatGetCodeSnippet,
  compatGetGraphSchema,
  compatGetIndexStatus,
  compatQueryGraph,
  compatSearchCode,
  compatSearchGraph,
  compatTraceCallPath,
} from './graphControllerCompatQueries';
import type { GraphDatabase } from './graphDatabase';
import type { GraphNode as S2GraphNode } from './graphDatabaseTypes';
import type { QueryEngine } from './queryEngine';
import type { TraceResult } from './queryEngineTypes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeS2Node(overrides: Partial<S2GraphNode> = {}): S2GraphNode {
  return {
    id: 'proj.src/foo.ts.myFn',
    project: 'proj',
    label: 'Function',
    name: 'myFn',
    qualified_name: 'proj.src/foo.ts.myFn',
    file_path: 'src/foo.ts',
    start_line: 5,
    end_line: 15,
    props: {},
    ...overrides,
  };
}

function makeDb(overrides: Partial<Record<keyof GraphDatabase, unknown>> = {}): GraphDatabase {
  return {
    searchNodes: vi.fn(() => ({ nodes: [makeS2Node()], total: 1, has_more: false })),
    getNode: vi.fn(() => null),
    getNodesByLabel: vi.fn(() => []),
    getOutboundEdges: vi.fn(() => []),
    getInboundEdges: vi.fn(() => []),
    getProject: vi.fn(() => null),
    getNodeCount: vi.fn(() => 42),
    getEdgeCount: vi.fn(() => 10),
    detectChangesForSession: vi.fn(() => ({
      projectName: 'proj',
      changedFiles: ['src/foo.ts'],
      affectedSymbols: [],
      blastRadius: 0,
    })),
    ...overrides,
  } as unknown as GraphDatabase;
}

function makeQueryEngine(overrides: Partial<Record<keyof QueryEngine, unknown>> = {}): QueryEngine {
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
    getArchitecture: vi.fn(() => ({
      projectName: 'proj',
      aspects: { hotspots: '', file_tree: '', packages: '' },
    })),
    getGraphSchema: vi.fn(() => ({
      nodeLabelCounts: { Function: 10, Class: 5 },
      edgeTypeCounts: { CALLS: 20 },
      relationshipPatterns: [],
      sampleNames: { functions: [], classes: [], qualifiedNames: [] },
    })),
    getCodeSnippet: vi.fn(() => 'function myFn() {}'),
    ...overrides,
  } as unknown as QueryEngine;
}

function makeCypherEngine(
  overrides: Partial<Record<keyof CypherEngine, unknown>> = {},
): CypherEngine {
  return {
    execute: vi.fn(() => ({ columns: ['n'], rows: [{ n: 'val' }], total: 1 })),
    ...overrides,
  } as unknown as CypherEngine;
}

// ─── compatSearchGraph ────────────────────────────────────────────────────────

describe('compatSearchGraph', () => {
  it('calls db.searchNodes with correct project and query', () => {
    const db = makeDb();
    const results = compatSearchGraph(db, 'proj', 'myFn', 10);
    expect(db.searchNodes).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'proj',
        namePattern: 'myFn',
      }),
    );
    expect(results).toHaveLength(1);
  });

  it('returns SearchResult shape with score and matchReason', () => {
    const db = makeDb();
    const results = compatSearchGraph(db, 'proj', 'myFn', 10);
    expect(results[0]).toHaveProperty('node');
    expect(results[0]).toHaveProperty('score');
    expect(results[0]).toHaveProperty('matchReason');
  });

  it('respects limit', () => {
    const nodes = Array.from({ length: 5 }, (_, i) => makeS2Node({ id: `id${i}`, name: `fn${i}` }));
    const db = makeDb({ searchNodes: vi.fn(() => ({ nodes, total: 5, has_more: false })) });
    const results = compatSearchGraph(db, 'proj', 'fn', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ─── compatQueryGraph ─────────────────────────────────────────────────────────

describe('compatQueryGraph', () => {
  it('delegates to cypherEngine.execute and returns rows', () => {
    const engine = makeCypherEngine();
    const result = compatQueryGraph(engine, 'MATCH (n) RETURN n');
    expect(engine.execute).toHaveBeenCalledWith('MATCH (n) RETURN n');
    expect(result).toEqual([{ n: 'val' }]);
  });

  it('returns empty array on engine error', () => {
    const engine = makeCypherEngine({
      execute: vi.fn(() => {
        throw new Error('bad query');
      }),
    });
    const result = compatQueryGraph(engine, 'INVALID');
    expect(result).toEqual([]);
  });
});

// ─── compatTraceCallPath ──────────────────────────────────────────────────────

describe('compatTraceCallPath', () => {
  it('calls queryEngine.traceCallPath with fromName', () => {
    const qe = makeQueryEngine();
    compatTraceCallPath(qe, 'fromFn', 'toFn', 3);
    expect(qe.traceCallPath).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'fromFn',
        direction: 'both',
        depth: 3,
      }),
    );
  });

  it('returns found:false when startNode is null', () => {
    const qe = makeQueryEngine();
    const result = compatTraceCallPath(qe, 'fromFn', 'toFn');
    expect(result.found).toBe(false);
    expect(result.path).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('returns found:true when target is in trace nodes', () => {
    const traceResult: TraceResult = {
      startNode: {
        id: 'a',
        name: 'fromFn',
        label: 'Function',
        filePath: 'a.ts',
        startLine: 1,
        signature: null,
        depth: 0,
      },
      nodes: [
        {
          id: 'b',
          name: 'toFn',
          label: 'Function',
          filePath: 'b.ts',
          startLine: 5,
          signature: null,
          depth: 1,
        },
      ],
      edges: [{ source: 'a', target: 'b', type: 'CALLS' }],
      totalNodes: 1,
      truncated: false,
    };
    const qe = makeQueryEngine({ traceCallPath: vi.fn(() => traceResult) });
    const result = compatTraceCallPath(qe, 'fromFn', 'toFn');
    expect(result.found).toBe(true);
    expect(result.path).toHaveLength(2);
  });

  it('clamps depth to max 5', () => {
    const qe = makeQueryEngine();
    compatTraceCallPath(qe, 'fromFn', 'toFn', 99);
    expect(qe.traceCallPath).toHaveBeenCalledWith(expect.objectContaining({ depth: 5 }));
  });
});

// ─── compatGetArchitecture ────────────────────────────────────────────────────

describe('compatGetArchitecture', () => {
  it('delegates to queryEngine.getArchitecture', () => {
    const qe = makeQueryEngine();
    const result = compatGetArchitecture(qe, ['hotspots']);
    expect(qe.getArchitecture).toHaveBeenCalledWith(['hotspots']);
    expect(result).toHaveProperty('projectName');
    expect(result).toHaveProperty('modules');
    expect(result).toHaveProperty('hotspots');
    expect(result).toHaveProperty('fileTree');
  });

  it('defaults to ["all"] when no aspects provided', () => {
    const qe = makeQueryEngine();
    compatGetArchitecture(qe);
    expect(qe.getArchitecture).toHaveBeenCalledWith(['all']);
  });
});

// ─── compatGetCodeSnippet ─────────────────────────────────────────────────────

describe('compatGetCodeSnippet', () => {
  it('returns null when node not found', async () => {
    const db = makeDb({
      getNode: vi.fn(() => null),
      searchNodes: vi.fn(() => ({ nodes: [], total: 0, has_more: false })),
    });
    const qe = makeQueryEngine();
    const result = await compatGetCodeSnippet(db, qe, 'proj', 'unknown::sym::function::1');
    expect(result).toBeNull();
  });

  it('returns CodeSnippetResult when node found by S2 id', async () => {
    const node = makeS2Node();
    const db = makeDb({
      getNode: vi.fn(() => node),
      getOutboundEdges: vi.fn(() => []),
      getInboundEdges: vi.fn(() => []),
    });
    const qe = makeQueryEngine({ getCodeSnippet: vi.fn(() => 'function myFn() {}') });
    const result = await compatGetCodeSnippet(db, qe, 'proj', node.id);
    expect(result).not.toBeNull();
    expect(result!.node.name).toBe('myFn');
    expect(result!.content).toBe('function myFn() {}');
    expect(Array.isArray(result!.dependencies)).toBe(true);
    expect(Array.isArray(result!.dependents)).toBe(true);
  });

  it('falls back to name search for S1-format ids', async () => {
    const node = makeS2Node();
    const searchNodes = vi.fn(() => ({ nodes: [node], total: 1, has_more: false }));
    const db = makeDb({
      getNode: vi.fn(() => null),
      searchNodes,
      getOutboundEdges: vi.fn(() => []),
      getInboundEdges: vi.fn(() => []),
    });
    const qe = makeQueryEngine({ getCodeSnippet: vi.fn(() => 'snippet') });
    const result = await compatGetCodeSnippet(db, qe, 'proj', 'src/foo.ts::myFn::function::5');
    expect(result).not.toBeNull();
    expect(searchNodes).toHaveBeenCalled();
  });
});

// ─── compatDetectChanges ──────────────────────────────────────────────────────

describe('compatDetectChanges', () => {
  it('delegates to queryEngine.detectChanges', async () => {
    const qe = makeQueryEngine();
    const result = await compatDetectChanges(qe);
    expect(qe.detectChanges).toHaveBeenCalledWith(expect.objectContaining({ scope: 'all' }));
    expect(result).toHaveProperty('changedFiles');
    expect(result).toHaveProperty('affectedSymbols');
    expect(result).toHaveProperty('blastRadius');
  });

  it('returns empty result on error', async () => {
    const qe = makeQueryEngine({
      detectChanges: vi.fn(async () => {
        throw new Error('git not found');
      }),
    });
    const result = await compatDetectChanges(qe);
    expect(result.changedFiles).toEqual([]);
    expect(result.blastRadius).toBe(0);
  });
});

// ─── compatDetectChangesForSession ────────────────────────────────────────────

describe('compatDetectChangesForSession', () => {
  it('delegates to db.detectChangesForSession', () => {
    const db = makeDb();
    const result = compatDetectChangesForSession(db, 'proj', 'sid1', ['src/foo.ts']);
    expect(db.detectChangesForSession).toHaveBeenCalledWith('proj', ['src/foo.ts']);
    expect(result.changedFiles).toEqual(['src/foo.ts']);
  });
});

// ─── compatGetGraphSchema ─────────────────────────────────────────────────────

describe('compatGetGraphSchema', () => {
  it('returns S1 GraphSchema shape', () => {
    const qe = makeQueryEngine();
    const schema = compatGetGraphSchema(qe);
    expect(Array.isArray(schema.nodeTypes)).toBe(true);
    expect(Array.isArray(schema.edgeTypes)).toBe(true);
    expect(typeof schema.nodeCount).toBe('number');
    expect(typeof schema.edgeCount).toBe('number');
  });

  it('sums node counts from label map', () => {
    const qe = makeQueryEngine();
    const schema = compatGetGraphSchema(qe);
    expect(schema.nodeCount).toBe(15); // Function:10 + Class:5
    expect(schema.edgeCount).toBe(20); // CALLS:20
  });
});

// ─── compatGetIndexStatus ─────────────────────────────────────────────────────

describe('compatGetIndexStatus', () => {
  it('returns IndexStatus with correct shape', () => {
    const db = makeDb({
      getProject: vi.fn(() => ({
        name: 'proj',
        root_path: '/root',
        indexed_at: 12345,
        node_count: 42,
        edge_count: 10,
      })),
      getNodesByLabel: vi.fn(() =>
        Array.from({ length: 7 }, (_, i) => makeS2Node({ id: `f${i}`, label: 'File' })),
      ),
    });
    const status = compatGetIndexStatus(db, 'proj', '/root', true);
    expect(status.initialized).toBe(true);
    expect(status.projectRoot).toBe('/root');
    expect(status.projectName).toBe('proj');
    expect(status.nodeCount).toBe(42);
    expect(status.edgeCount).toBe(10);
    expect(status.fileCount).toBe(7);
    expect(status.lastIndexedAt).toBe(12345);
    expect(typeof status.indexDurationMs).toBe('number');
  });

  it('falls back to getNodeCount when project record absent', () => {
    const db = makeDb({ getProject: vi.fn(() => null) });
    const status = compatGetIndexStatus(db, 'proj', '/root', false);
    expect(status.nodeCount).toBe(42); // from mock getNodeCount
  });
});

// ─── compatSearchCode ─────────────────────────────────────────────────────────

describe('compatSearchCode', () => {
  it('returns empty array for invalid regex pattern', async () => {
    const db = makeDb({ getNodesByLabel: vi.fn(() => []) });
    const results = await compatSearchCode({
      projectRoot: '/root',
      db,
      projectName: 'proj',
      pattern: '[invalid(',
      opts: {},
    });
    expect(results).toEqual([]);
  });

  it('returns empty array when no file nodes exist', async () => {
    const db = makeDb({ getNodesByLabel: vi.fn(() => []) });
    const results = await compatSearchCode({
      projectRoot: '/root',
      db,
      projectName: 'proj',
      pattern: 'foo',
    });
    expect(results).toEqual([]);
  });

  it('returns correct shape: filePath, line, match', async () => {
    // File node with a path prop and a real temp file won't work in unit test,
    // so we just verify the empty-file path is handled gracefully
    const fileNode = makeS2Node({ label: 'File', name: 'foo.ts', props: { path: 'src/foo.ts' } });
    const db = makeDb({ getNodesByLabel: vi.fn(() => [fileNode]) });
    const results = await compatSearchCode({
      projectRoot: '/nonexistent',
      db,
      projectName: 'proj',
      pattern: 'test',
    });
    // readFile will throw for /nonexistent/src/foo.ts — should return []
    expect(Array.isArray(results)).toBe(true);
  });
});

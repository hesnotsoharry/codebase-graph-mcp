/**
 * graphControllerCompat.test.ts — Unit tests for GraphControllerCompat.
 * Mocks all System 2 internals; asserts delegation and S1 shape conformance.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AutoSyncWatcher } from './autoSync';
import type { CypherEngine } from './cypherEngine';
import type { CompatHandle } from './graphControllerCompat';
import { GraphControllerCompat } from './graphControllerCompat';
import type { GraphDatabase } from './graphDatabase';
import type { GraphNode as S2GraphNode } from './graphDatabaseTypes';
import type { IndexingResult } from './indexingPipelineTypes';
import type { IndexingWorkerClient } from './indexingWorkerClient';
import type { QueryEngine } from './queryEngine';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

function makeIndexingResult(overrides: Partial<IndexingResult> = {}): IndexingResult {
  return {
    projectName: 'proj',
    success: true,
    filesIndexed: 10,
    filesSkipped: 0,
    nodesCreated: 50,
    edgesCreated: 20,
    errors: [],
    durationMs: 100,
    incremental: true,
    ...overrides,
  };
}

function makeHandle(overrides: Partial<CompatHandle> = {}): CompatHandle {
  const db: GraphDatabase = {
    searchNodes: vi.fn(() => ({ nodes: [makeS2Node()], total: 1, has_more: false })),
    getNode: vi.fn(() => null),
    getNodesByLabel: vi.fn(() => []),
    getOutboundEdges: vi.fn(() => []),
    getInboundEdges: vi.fn(() => []),
    getProject: vi.fn(() => ({
      name: 'proj',
      root_path: '/proj',
      indexed_at: 1000,
      node_count: 5,
      edge_count: 3,
    })),
    getNodeCount: vi.fn(() => 5),
    getEdgeCount: vi.fn(() => 3),
    deleteProject: vi.fn(),
    insertEdges: vi.fn(),
    detectChangesForSession: vi.fn(() => ({
      projectName: 'proj',
      changedFiles: [],
      affectedSymbols: [],
      blastRadius: 0,
    })),
  } as unknown as GraphDatabase;

  const queryEngine: QueryEngine = {
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
      nodeLabelCounts: { Function: 5 },
      edgeTypeCounts: { CALLS: 3 },
      relationshipPatterns: [],
      sampleNames: { functions: [], classes: [], qualifiedNames: [] },
    })),
    getCodeSnippet: vi.fn(() => 'function myFn() {}'),
  } as unknown as QueryEngine;

  const cypherEngine: CypherEngine = {
    execute: vi.fn(() => ({ columns: ['n'], rows: [], total: 0 })),
  } as unknown as CypherEngine;

  const workerClient: IndexingWorkerClient = {
    runIndex: vi.fn(async () => makeIndexingResult()),
  } as unknown as IndexingWorkerClient;

  const watcher: AutoSyncWatcher = {
    onFileChange: vi.fn(),
    onSessionStart: vi.fn(),
    onGitCommit: vi.fn(),
    dispose: vi.fn(),
  } as unknown as AutoSyncWatcher;

  return {
    db,
    queryEngine,
    cypherEngine,
    workerClient,
    watcher,
    projectRoot: '/proj',
    projectName: 'proj',
    ...overrides,
  };
}

// ─── Constructor ──────────────────────────────────────────────────────────────

describe('GraphControllerCompat constructor', () => {
  it('sets rootPath from handle.projectRoot', () => {
    const compat = new GraphControllerCompat(makeHandle());
    expect(compat.rootPath).toBe('/proj');
  });

  it('initializes as initialized when project exists in db', () => {
    const compat = new GraphControllerCompat(makeHandle());
    expect(compat.getStatus().initialized).toBe(true);
  });

  it('initializes as not initialized when project absent from db', () => {
    const handle = makeHandle();
    (handle.db.getProject as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const compat = new GraphControllerCompat(handle);
    expect(compat.getStatus().initialized).toBe(false);
  });
});

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('getStatus', () => {
  it('returns IndexStatus with all required fields', () => {
    const compat = new GraphControllerCompat(makeHandle());
    const status = compat.getStatus();
    expect(status).toHaveProperty('initialized');
    expect(status).toHaveProperty('projectRoot');
    expect(status).toHaveProperty('projectName');
    expect(status).toHaveProperty('nodeCount');
    expect(status).toHaveProperty('edgeCount');
    expect(status).toHaveProperty('fileCount');
    expect(status).toHaveProperty('lastIndexedAt');
    expect(status).toHaveProperty('indexDurationMs');
  });

  it('indexStatus is an alias for getStatus', () => {
    const compat = new GraphControllerCompat(makeHandle());
    expect(compat.indexStatus()).toEqual(compat.getStatus());
  });
});

// ─── getGraphToolContext ──────────────────────────────────────────────────────

describe('getGraphToolContext', () => {
  it('returns GraphToolContext with pipeline, projectRoot, projectName', () => {
    const compat = new GraphControllerCompat(makeHandle());
    const ctx = compat.getGraphToolContext();
    expect(ctx).toHaveProperty('pipeline');
    expect(ctx).toHaveProperty('projectRoot', '/proj');
    expect(ctx).toHaveProperty('projectName', 'proj');
    expect(typeof ctx.pipeline.index).toBe('function');
  });

  it('pipeline.index delegates to workerClient.runIndex', async () => {
    const handle = makeHandle();
    const compat = new GraphControllerCompat(handle);
    const ctx = compat.getGraphToolContext();
    await ctx.pipeline.index({ projectRoot: '/proj', projectName: 'proj', incremental: true });
    expect(handle.workerClient.runIndex).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: '/proj', incremental: true }),
    );
  });
});

// ─── Lifecycle methods ────────────────────────────────────────────────────────

describe('lifecycle methods', () => {
  it('onFileChange delegates to watcher.onFileChange', () => {
    const handle = makeHandle();
    const compat = new GraphControllerCompat(handle);
    compat.onFileChange(['src/a.ts']);
    expect(handle.watcher!.onFileChange).toHaveBeenCalledWith(['src/a.ts']);
  });

  it('onFileChange with no args passes empty array', () => {
    const handle = makeHandle();
    const compat = new GraphControllerCompat(handle);
    compat.onFileChange();
    expect(handle.watcher!.onFileChange).toHaveBeenCalledWith([]);
  });

  it('onSessionStart delegates to watcher.onSessionStart', () => {
    const handle = makeHandle();
    const compat = new GraphControllerCompat(handle);
    compat.onSessionStart();
    expect(handle.watcher!.onSessionStart).toHaveBeenCalled();
  });

  it('onGitCommit delegates to watcher.onGitCommit', () => {
    const handle = makeHandle();
    const compat = new GraphControllerCompat(handle);
    compat.onGitCommit();
    expect(handle.watcher!.onGitCommit).toHaveBeenCalled();
  });

  it('dispose sets initialized to false', async () => {
    const compat = new GraphControllerCompat(makeHandle());
    await compat.dispose();
    expect(compat.getStatus().initialized).toBe(false);
  });

  it('onFileChange is no-op when watcher is null', () => {
    const handle = makeHandle({ watcher: null });
    const compat = new GraphControllerCompat(handle);
    expect(() => compat.onFileChange(['a.ts'])).not.toThrow();
  });
});

// ─── indexRepository ─────────────────────────────────────────────────────────

describe('indexRepository', () => {
  it('delegates to workerClient.runIndex and returns success', async () => {
    const handle = makeHandle();
    const compat = new GraphControllerCompat(handle);
    const result = await compat.indexRepository({
      projectRoot: '/proj',
      projectName: 'proj',
      incremental: true,
    });
    expect(result.success).toBe(true);
    expect(handle.workerClient.runIndex).toHaveBeenCalled();
  });

  it('returns success:false on error', async () => {
    const handle = makeHandle();
    (handle.workerClient.runIndex as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
    const compat = new GraphControllerCompat(handle);
    const result = await compat.indexRepository({
      projectRoot: '/proj',
      projectName: 'proj',
      incremental: false,
    });
    expect(result.success).toBe(false);
  });
});

// ─── listProjects / deleteProject ────────────────────────────────────────────

describe('listProjects', () => {
  it('returns rootPath when initialized', () => {
    const compat = new GraphControllerCompat(makeHandle());
    expect(compat.listProjects()).toContain('/proj');
  });

  it('returns empty array when not initialized', () => {
    const handle = makeHandle();
    (handle.db.getProject as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const compat = new GraphControllerCompat(handle);
    expect(compat.listProjects()).toEqual([]);
  });
});

describe('deleteProject', () => {
  it('returns success:false for wrong root', () => {
    const compat = new GraphControllerCompat(makeHandle());
    expect(compat.deleteProject('/other').success).toBe(false);
  });

  it('deletes project from db and marks uninitialized', () => {
    const handle = makeHandle();
    const compat = new GraphControllerCompat(handle);
    const result = compat.deleteProject('/proj');
    expect(result.success).toBe(true);
    expect(handle.db.deleteProject).toHaveBeenCalledWith('proj');
    expect(compat.getStatus().initialized).toBe(false);
  });
});

// ─── searchGraph ──────────────────────────────────────────────────────────────

describe('searchGraph', () => {
  it('returns SearchResult[] with correct shape', () => {
    const compat = new GraphControllerCompat(makeHandle());
    const results = compat.searchGraph('myFn');
    expect(Array.isArray(results)).toBe(true);
    if (results.length > 0) {
      expect(results[0]).toHaveProperty('node');
      expect(results[0]).toHaveProperty('score');
      expect(results[0]).toHaveProperty('matchReason');
    }
  });
});

// ─── queryGraph ───────────────────────────────────────────────────────────────

describe('queryGraph', () => {
  it('delegates to cypherEngine and returns rows', () => {
    const handle = makeHandle();
    (handle.cypherEngine.execute as ReturnType<typeof vi.fn>).mockReturnValue({
      columns: ['n'],
      rows: [{ n: 'foo' }],
      total: 1,
    });
    const compat = new GraphControllerCompat(handle);
    const result = compat.queryGraph('MATCH (n) RETURN n');
    expect(handle.cypherEngine.execute).toHaveBeenCalledWith('MATCH (n) RETURN n');
    expect(result).toEqual([{ n: 'foo' }]);
  });
});

// ─── traceCallPath ────────────────────────────────────────────────────────────

describe('traceCallPath', () => {
  it('returns CallPathResult shape', () => {
    const compat = new GraphControllerCompat(makeHandle());
    const result = compat.traceCallPath(
      'src/a.ts::fromFn::function::1',
      'src/b.ts::toFn::function::5',
    );
    expect(result).toHaveProperty('found');
    expect(result).toHaveProperty('path');
    expect(result).toHaveProperty('edges');
  });

  it('extracts name from S1-format id for queryEngine call', () => {
    const handle = makeHandle();
    const compat = new GraphControllerCompat(handle);
    compat.traceCallPath('src/a.ts::fromFn::function::1', 'src/b.ts::toFn::function::5');
    expect(handle.queryEngine.traceCallPath).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'fromFn' }),
    );
  });
});

// ─── getArchitecture ──────────────────────────────────────────────────────────

describe('getArchitecture', () => {
  it('returns ArchitectureView shape', () => {
    const compat = new GraphControllerCompat(makeHandle());
    const view = compat.getArchitecture();
    expect(view).toHaveProperty('projectName');
    expect(view).toHaveProperty('modules');
    expect(view).toHaveProperty('hotspots');
    expect(view).toHaveProperty('fileTree');
  });

  it('passes aspects to queryEngine', () => {
    const handle = makeHandle();
    const compat = new GraphControllerCompat(handle);
    compat.getArchitecture(['hotspots']);
    expect(handle.queryEngine.getArchitecture).toHaveBeenCalledWith(['hotspots']);
  });
});

// ─── getCodeSnippet ───────────────────────────────────────────────────────────

describe('getCodeSnippet', () => {
  it('returns null when symbol not found', async () => {
    const handle = makeHandle();
    (handle.db.searchNodes as ReturnType<typeof vi.fn>).mockReturnValue({
      nodes: [],
      total: 0,
      has_more: false,
    });
    const compat = new GraphControllerCompat(handle);
    const result = await compat.getCodeSnippet('unknown::sym::function::1');
    expect(result).toBeNull();
  });

  it('returns CodeSnippetResult when found', async () => {
    const node = makeS2Node();
    const handle = makeHandle();
    (handle.db.getNode as ReturnType<typeof vi.fn>).mockReturnValue(node);
    const compat = new GraphControllerCompat(handle);
    const result = await compat.getCodeSnippet(node.id);
    expect(result).not.toBeNull();
    expect(result!.node.name).toBe('myFn');
    expect(result!.content).toBe('function myFn() {}');
  });
});

// ─── getGraphSchema ───────────────────────────────────────────────────────────

describe('getGraphSchema', () => {
  it('returns GraphSchema shape', () => {
    const compat = new GraphControllerCompat(makeHandle());
    const schema = compat.getGraphSchema();
    expect(Array.isArray(schema.nodeTypes)).toBe(true);
    expect(Array.isArray(schema.edgeTypes)).toBe(true);
    expect(typeof schema.nodeCount).toBe('number');
    expect(typeof schema.edgeCount).toBe('number');
  });
});

// ─── detectChanges / detectChangesForSession ──────────────────────────────────

describe('detectChanges', () => {
  it('returns ChangeDetectionResult shape', async () => {
    const compat = new GraphControllerCompat(makeHandle());
    const result = await compat.detectChanges();
    expect(result).toHaveProperty('changedFiles');
    expect(result).toHaveProperty('affectedSymbols');
    expect(result).toHaveProperty('blastRadius');
  });
});

describe('detectChangesForSession', () => {
  it('delegates to db.detectChangesForSession', async () => {
    const handle = makeHandle();
    (handle.db.detectChangesForSession as ReturnType<typeof vi.fn>).mockReturnValue({
      projectName: 'proj',
      changedFiles: ['src/a.ts'],
      affectedSymbols: [],
      blastRadius: 0,
    });
    const compat = new GraphControllerCompat(handle);
    const result = await compat.detectChangesForSession('sid1', ['src/a.ts']);
    expect(handle.db.detectChangesForSession).toHaveBeenCalledWith('proj', ['src/a.ts']);
    expect(result.changedFiles).toEqual(['src/a.ts']);
  });
});

// ─── ingestTraces ─────────────────────────────────────────────────────────────

describe('ingestTraces', () => {
  it('inserts valid trace edges', () => {
    const handle = makeHandle();
    const compat = new GraphControllerCompat(handle);
    const result = compat.ingestTraces([{ fromId: 'a', toId: 'b', type: 'HTTP_CALLS' }]);
    expect(result.success).toBe(true);
    expect(result.ingested).toBe(1);
    expect(handle.db.insertEdges).toHaveBeenCalled();
  });

  it('returns success:false for non-array input', () => {
    const compat = new GraphControllerCompat(makeHandle());
    expect(compat.ingestTraces('bad' as unknown as unknown[]).success).toBe(false);
  });

  it('skips invalid trace entries', () => {
    const handle = makeHandle();
    const compat = new GraphControllerCompat(handle);
    const result = compat.ingestTraces([
      { fromId: 'a' },
      { fromId: 'a', toId: 'b', type: 'CALLS' },
    ]);
    expect(result.ingested).toBe(1);
  });
});

// ─── manageAdr ────────────────────────────────────────────────────────────────

describe('manageAdr', () => {
  it('returns success:true for list action', () => {
    const compat = new GraphControllerCompat(makeHandle());
    const result = compat.manageAdr('list') as { success: boolean; message: string };
    expect(result.success).toBe(true);
    expect(result.message).toContain('ADR directory');
  });

  it('returns success:false for unknown action', () => {
    const compat = new GraphControllerCompat(makeHandle());
    const result = compat.manageAdr('unknown' as 'list') as { success: boolean };
    expect(result.success).toBe(false);
  });
});

// ─── searchCode ───────────────────────────────────────────────────────────────

describe('searchCode', () => {
  it('returns empty array when no files indexed', async () => {
    const compat = new GraphControllerCompat(makeHandle());
    const results = await compat.searchCode('pattern');
    expect(Array.isArray(results)).toBe(true);
  });
});

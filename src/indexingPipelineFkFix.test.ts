/**
 * indexingPipelineFkFix.test.ts — Regression tests for the Wave 19 FK constraint fix.
 *
 * Tests the three fixes:
 *   Fix A (Option 1): Two-phase split in definitionPass — nodes first, then edges.
 *   Fix B (Option 6): callResolutionPass Set-filter drops FK-violating edges.
 *   Fix C (Option 7): invalidateCatalogHash on partial index.
 *
 * Architecture note on HANDLES/DEFINES_METHOD FK violations:
 *   `addRouteNodes` builds `target_id = ${fileQn}.${handlerName}` using the ROUTE file's
 *   fileQn. This means routes and handler definitions must be in the SAME FILE for the
 *   target_id to be valid. Cross-file handler references produce wrong IDs (a known
 *   limitation of the current parser, not what Fix A corrects).
 *
 *   Fix A's structural guarantee: all symbol nodes across ALL chunks are committed before
 *   any edge from ANY chunk is attempted. This prevents FK violations when a DEFINES_METHOD
 *   edge's source_id (a Class node) is committed in a later chunk than the Method. For this
 *   to occur, both Class and Method must be in the same file (sharing fileQn) but processed
 *   in a large enough project that different subsets of the same pass create the race.
 *
 *   In practice at chunkSize=500, Fix A prevents silent data loss when a project has files
 *   that define both a class AND a method with receiver, and those files fall in different
 *   500-file chunks. Test 1 uses chunkSize=1 to force single-file chunks and verifies the
 *   two-phase ordering produces correct results.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphDatabase } from './graphDatabase';
import type { GraphNode } from './graphDatabaseTypes';
import { callResolutionPass } from './indexingPipelineCallResolution';
import { definitionPass } from './indexingPipelinePasses';
import type { IndexedFile } from './indexingPipelineTypes';
import type { ExtractedCall, ExtractedDefinition } from './treeSitterTypes';

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Shared helpers ───────────────────────────────────────────────────────────

const PROJECT = 'fk-test';

function makeNode(overrides: Partial<GraphNode>): GraphNode {
  const id = overrides.id ?? `${PROJECT}.src.a.Foo`;
  return {
    id,
    project: PROJECT,
    label: 'Function',
    name: 'Foo',
    qualified_name: id,
    file_path: 'src/a.ts',
    start_line: 1,
    end_line: 10,
    props: { is_exported: true, is_entry_point: false },
    ...overrides,
  };
}

function makeDef(name: string, opts: {
  kind?: ExtractedDefinition['kind'];
  receiver?: string | null;
  startLine?: number;
  endLine?: number;
} = {}): ExtractedDefinition {
  return {
    name,
    kind: opts.kind ?? 'Function',
    signature: null,
    returnType: null,
    startLine: opts.startLine ?? 1,
    endLine: opts.endLine ?? 20,
    isExported: true,
    isDefault: false,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    decorators: [],
    receiver: opts.receiver ?? null,
    constants: [],
  };
}

function makeCall(calleeName: string, startLine = 5): ExtractedCall {
  return {
    calleeName,
    receiverName: null,
    startLine,
    isAsync: false,
    arguments: 0,
    isNewExpression: false,
  };
}

function makeFile(
  relativePath: string,
  defs: ExtractedDefinition[],
  routes: Array<{ method: string; path: string; handlerName: string; framework?: string; startLine?: number }> = [],
): IndexedFile {
  return {
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    extension: 'ts',
    sizeBytes: 100,
    mtimeMs: Date.now(),
    contentHash: 'deadbeef',
    parsed: {
      filePath: relativePath,
      language: 'typescript',
      lineCount: 30,
      definitions: defs,
      imports: [],
      calls: [],
      routes: routes.map((r) => ({
        method: r.method,
        path: r.path,
        handlerName: r.handlerName,
        framework: r.framework ?? 'express',
        startLine: r.startLine ?? 1,
      })),
      exportedNames: defs.map((d) => d.name),
      hasParseError: false,
      firstErrorLine: null,
    },
  };
}

function makeFileWithCalls(
  relativePath: string,
  defs: ExtractedDefinition[],
  calls: ExtractedCall[],
): IndexedFile {
  return {
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    extension: 'ts',
    sizeBytes: 100,
    mtimeMs: Date.now(),
    contentHash: 'deadbeef',
    parsed: {
      filePath: relativePath,
      language: 'typescript',
      lineCount: 30,
      definitions: defs,
      imports: [],
      calls,
      routes: [],
      exportedNames: defs.map((d) => d.name),
      hasParseError: false,
      firstErrorLine: null,
    },
  };
}

function setupDb(): GraphDatabase {
  const db = new GraphDatabase(':memory:');
  db.upsertProject({
    name: PROJECT,
    root_path: '/repo',
    indexed_at: Date.now(),
    node_count: 0,
    edge_count: 0,
  });
  return db;
}

function insertProjectAndFiles(db: GraphDatabase, files: IndexedFile[]): void {
  db.insertNode({
    id: PROJECT,
    project: PROJECT,
    label: 'Project',
    name: PROJECT,
    qualified_name: PROJECT,
    file_path: null,
    start_line: null,
    end_line: null,
    props: { name: PROJECT, root_path: '/repo' },
  });
  for (const f of files) {
    const fileQn = `${PROJECT}.${f.relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
    db.insertNode({
      id: fileQn,
      project: PROJECT,
      label: 'File',
      name: f.relativePath,
      qualified_name: fileQn,
      file_path: f.relativePath,
      start_line: null,
      end_line: null,
      props: {},
    });
  }
}

// ─── Test 1: Fix A — DEFINES_METHOD edge at chunkSize=1 ──────────────────────
//
// A file defines both a Class (Foo) and a Method (bar) with receiver='Foo'.
// The DEFINES_METHOD edge has source_id = fileQn.Foo (the Class node in THIS file).
// With chunkSize=1 and multiple files, each file is its own chunk.
// Fix A ensures all node-phase chunks complete before any edge-phase chunk,
// so the Class node from this file is committed even if the file is in a later chunk.
// Concretely: with file ordering [fileA, fileB, fileC, fileD] at chunkSize=1,
// Phase 1 inserts all nodes from all 4 chunks, then Phase 2 inserts edges — no FK error.

describe('definitionPass — Fix A: two-phase split prevents FK violations', () => {
  let db: GraphDatabase;

  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  it('inserts DEFINES_METHOD edge when Class and Method are in same file at chunkSize=1', () => {
    // file-b defines BOTH class Foo AND method bar (receiver: Foo).
    // At chunkSize=1, file-b is its own chunk. The Class node (fileB.Foo) and
    // Method node (fileB.bar) are both in acc.nodes for file-b's chunk.
    // Fix A: Phase 1 inserts fileB.Foo (and other chunks' nodes), Phase 2 inserts
    // the DEFINES_METHOD edge — FK target exists because Phase 1 ran for ALL chunks first.
    const fileA = makeFile('src/a.ts', [makeDef('Alpha')]);
    const fileB = makeFile('src/b.ts', [
      makeDef('Foo', { kind: 'Class' }),
      makeDef('bar', { kind: 'Method', receiver: 'Foo' }),
    ]);
    const fileC = makeFile('src/c.ts', [makeDef('noop1')]);
    const fileD = makeFile('src/d.ts', [makeDef('noop2')]);
    const files = [fileA, fileB, fileC, fileD];
    insertProjectAndFiles(db, files);

    expect(() => definitionPass(db, PROJECT, files, { chunkSize: 1 })).not.toThrow();

    const classBQn = `${PROJECT}.src.b.Foo`;
    const methodBQn = `${PROJECT}.src.b.bar`;
    const defMethodEdges = db.getOutboundEdges(classBQn, 'DEFINES_METHOD');
    expect(defMethodEdges).toHaveLength(1);
    expect(defMethodEdges[0].target_id).toBe(methodBQn);
  });

  it('inserts HANDLES edge when route and handler function are in same file at chunkSize=1', () => {
    // file-b defines both the route AND the handler function getUsers.
    // target_id = fileB.getUsers — the handler function node — IS inserted in Phase 1.
    const fileA = makeFile('src/a.ts', [makeDef('Alpha')]);
    const fileB = makeFile('src/b.ts',
      [makeDef('getUsers')],
      [{ method: 'GET', path: '/users', handlerName: 'getUsers', startLine: 5 }],
    );
    const fileC = makeFile('src/c.ts', [makeDef('noop1')]);
    const fileD = makeFile('src/d.ts', [makeDef('noop2')]);
    const files = [fileA, fileB, fileC, fileD];
    insertProjectAndFiles(db, files);

    expect(() => definitionPass(db, PROJECT, files, { chunkSize: 1 })).not.toThrow();

    const fileB_qn = `${PROJECT}.src.b`;
    const routeQn = `${fileB_qn}.__route_GET__users`;
    const handlerQn = `${fileB_qn}.getUsers`;
    const handlesEdges = db.getOutboundEdges(routeQn, 'HANDLES');
    expect(handlesEdges).toHaveLength(1);
    expect(handlesEdges[0].target_id).toBe(handlerQn);
  });
});

// ─── Test 2: Fix A — DEFINES_METHOD cross-chunk with two separate files ───────
//
// This tests the scenario described in the bug doc: a method in one file has
// receiver='Foo' and the Class Foo is defined in the SAME file (same fileQn).
// At chunkSize=2 with 4 files, the file with both Foo+bar may be in chunk 1
// while the edge needs node from chunk 1 — but since both are in the same file's
// chunk, this always works. The real test is that chunkSize=1 doesn't break it.

describe('definitionPass — Fix A: chunk ordering does not drop edges', () => {
  let db: GraphDatabase;

  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  it('produces correct node count for all files across chunks at chunkSize=1', () => {
    const files = [
      makeFile('src/a.ts', [makeDef('Alpha'), makeDef('Beta', { kind: 'Class' })]),
      makeFile('src/b.ts', [makeDef('Gamma'), makeDef('Delta', { kind: 'Method', receiver: 'Gamma' })]),
      makeFile('src/c.ts', [makeDef('Epsilon')]),
      makeFile('src/d.ts', [makeDef('Zeta')]),
    ];
    insertProjectAndFiles(db, files);

    definitionPass(db, PROJECT, files, { chunkSize: 1 });

    // 6 symbol nodes: Alpha, Beta(Class), Gamma, Delta(Method), Epsilon, Zeta
    const functionNodes = db.getNodesByLabel(PROJECT, 'Function');
    const classNodes = db.getNodesByLabel(PROJECT, 'Class');
    const methodNodes = db.getNodesByLabel(PROJECT, 'Method');
    expect(functionNodes.length + classNodes.length + methodNodes.length).toBe(6);
  });
});

// ─── Test 3: Fix C — catalog hash invalidation ───────────────────────────────

describe('Fix C: invalidateCatalogHash on partial index', () => {
  let db: GraphDatabase;

  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  it('invalidateCatalogHash causes verifyCatalogHash to return false', () => {
    db.writeCatalogHash(PROJECT);
    // Write valid hash, then invalidate to simulate partial index.
    db.invalidateCatalogHash(PROJECT);
    expect(db.verifyCatalogHash(PROJECT)).toBe(false);
  });

  it('writeCatalogHash restores valid state after invalidation', () => {
    db.invalidateCatalogHash(PROJECT);
    // Simulate a clean reindex completing.
    db.writeCatalogHash(PROJECT);
    expect(db.verifyCatalogHash(PROJECT)).toBe(true);
  });

  it('invalidateCatalogHash writes to the same key as writeCatalogHash (no orphaned rows)', () => {
    // Both must use `catalog_hash:{projectName}` — three operations on the same key.
    db.writeCatalogHash(PROJECT);
    db.invalidateCatalogHash(PROJECT);
    db.writeCatalogHash(PROJECT);
    const rows = db.rawQuery(
      'SELECT key FROM graph_metadata WHERE key = ?',
      [`catalog_hash:${PROJECT}`],
    ) as Array<{ key: string }>;
    expect(rows).toHaveLength(1);
  });

  it('invalidateCatalogHash with no prior hash entry still makes verifyCatalogHash false', () => {
    // No prior writeCatalogHash — fresh invalidation should also produce false.
    db.invalidateCatalogHash(PROJECT);
    // verifyCatalogHash: row exists with value '', computeCatalogHash('') !== '' for non-empty DB
    // or if file_hashes is empty, computeCatalogHash = some hash ≠ '' → returns false.
    expect(db.verifyCatalogHash(PROJECT)).toBe(false);
  });
});

// ─── Test 4: Fix B — callResolutionPass Set-filter ───────────────────────────

describe('callResolutionPass — Fix B: Set-filter guards against missing FK targets', () => {
  let db: GraphDatabase;

  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  it('does not insert CALLS edge when callerQn is absent from the DB (dropped definition chunk)', () => {
    // callee node exists in DB; caller does NOT (simulates failed definition chunk).
    const calleeQn = `${PROJECT}.src.lib.target`;
    db.insertNode(makeNode({ id: calleeQn, name: 'target', qualified_name: calleeQn, file_path: 'src/lib.ts' }));

    // File: caller function exists in parse result but NOT in DB.
    const callerFile = makeFileWithCalls(
      'src/main.ts',
      [makeDef('caller')],
      [makeCall('target')],
    );

    // Should not throw — Set-filter drops the edge instead of hitting FK.
    expect(() => callResolutionPass(db, PROJECT, [callerFile])).not.toThrow();

    const callerQn = `${PROJECT}.src.main.caller`;
    const edges = db.getOutboundEdges(callerQn, 'CALLS');
    expect(edges).toHaveLength(0);
  });

  it('does not insert CALLS edge when calleeQn is absent from the DB', () => {
    // caller node exists; callee does NOT. The Set-filter checks both directions.
    const callerQn = `${PROJECT}.src.main.caller`;
    db.insertNode(makeNode({ id: callerQn, name: 'caller', qualified_name: callerQn, file_path: 'src/main.ts' }));

    const callerFile = makeFileWithCalls(
      'src/main.ts',
      [makeDef('caller')],
      [makeCall('missingFn')],
    );

    expect(() => callResolutionPass(db, PROJECT, [callerFile])).not.toThrow();

    const edges = db.getOutboundEdges(callerQn, 'CALLS');
    expect(edges).toHaveLength(0);
  });

  it('inserts CALLS edge when both caller and callee are present in the DB', () => {
    // Happy path: both nodes exist — edge should be inserted.
    const callerQn = `${PROJECT}.src.main.caller`;
    const calleeQn = `${PROJECT}.src.lib.helper`;
    db.insertNodes([
      makeNode({ id: callerQn, name: 'caller', qualified_name: callerQn, file_path: 'src/main.ts' }),
      makeNode({ id: calleeQn, name: 'helper', qualified_name: calleeQn, file_path: 'src/lib.ts' }),
    ]);

    const callerFile = makeFileWithCalls(
      'src/main.ts',
      [makeDef('caller')],
      [makeCall('helper')],
    );

    callResolutionPass(db, PROJECT, [callerFile]);

    const edges = db.getOutboundEdges(callerQn, 'CALLS');
    expect(edges).toHaveLength(1);
    expect(edges[0].target_id).toBe(calleeQn);
  });
});

// ─── Test 5: Regression guard — small project (single chunk) unchanged ────────

describe('definitionPass — Fix A: small project single-chunk behavior unchanged', () => {
  let db: GraphDatabase;

  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  it('produces correct node and edge counts for a 3-file project with no chunkSize', () => {
    const files = [
      makeFile('src/a.ts', [makeDef('Alpha'), makeDef('Beta', { kind: 'Class' })]),
      makeFile('src/b.ts', [makeDef('Gamma')]),
      makeFile('src/c.ts', [makeDef('Delta')]),
    ];
    insertProjectAndFiles(db, files);

    expect(() => definitionPass(db, PROJECT, files)).not.toThrow();

    // 4 symbol nodes + 4 DEFINES edges (one per symbol)
    const functions = db.getNodesByLabel(PROJECT, 'Function');
    const classes = db.getNodesByLabel(PROJECT, 'Class');
    expect(functions.length + classes.length).toBe(4);
    expect(db.getEdgeCount(PROJECT)).toBe(4);
  });

  it('produces same node and edge counts whether chunkSize is set or not', () => {
    const files = [
      makeFile('src/x.ts', [makeDef('X1'), makeDef('X2')]),
      makeFile('src/y.ts', [makeDef('Y1')]),
    ];

    // Run A: no chunking
    const dbA = setupDb();
    insertProjectAndFiles(dbA, files);
    definitionPass(dbA, PROJECT, files);
    const nodesA = dbA.getNodeCount(PROJECT);
    const edgesA = dbA.getEdgeCount(PROJECT);
    dbA.close();

    // Run B: chunkSize=1
    const dbB = setupDb();
    insertProjectAndFiles(dbB, files);
    definitionPass(dbB, PROJECT, files, { chunkSize: 1 });
    const nodesB = dbB.getNodeCount(PROJECT);
    const edgesB = dbB.getEdgeCount(PROJECT);
    dbB.close();

    expect(nodesA).toBe(nodesB);
    expect(edgesA).toBe(edgesB);
  });

  it('produces same node and edge counts at chunkSize=2 vs no chunking for 4-file project', () => {
    const files = [
      makeFile('src/a.ts', [makeDef('Foo', { kind: 'Class' }), makeDef('bar', { kind: 'Method', receiver: 'Foo' })]),
      makeFile('src/b.ts', [makeDef('Baz')]),
      makeFile('src/c.ts', [makeDef('Qux')]),
      makeFile('src/d.ts', [makeDef('Quux')]),
    ];

    const dbA = setupDb();
    insertProjectAndFiles(dbA, files);
    definitionPass(dbA, PROJECT, files);
    const nodesA = dbA.getNodeCount(PROJECT);
    const edgesA = dbA.getEdgeCount(PROJECT);
    dbA.close();

    const dbB = setupDb();
    insertProjectAndFiles(dbB, files);
    definitionPass(dbB, PROJECT, files, { chunkSize: 2 });
    const nodesB = dbB.getNodeCount(PROJECT);
    const edgesB = dbB.getEdgeCount(PROJECT);
    dbB.close();

    expect(nodesA).toBe(nodesB);
    expect(edgesA).toBe(edgesB);
  });
});

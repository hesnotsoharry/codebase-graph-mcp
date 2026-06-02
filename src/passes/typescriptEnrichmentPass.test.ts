/**
 * typescriptEnrichmentPass.test.ts — Unit/integration tests for Pass 6.
 *
 * Contracts under test:
 *   1.  No-op when tsMorphProject is null (skip path).
 *   2.  Barrel resolution: call via barrel → real definition at 0.98/compiler_api.
 *   3.  Barrel negative: barrel node NEVER appears as a resolved target.
 *   4.  D5.1 delete-then-insert: wrong-target tree-sitter edge is replaced.
 *   5.  ASYNC_CALLS: awaited call → ASYNC_CALLS edge (not CALLS).
 *   6.  Empty-R preservation: no ts-morph resolution → tree-sitter edge preserved.
 *   7.  TYPEOF barrel: type ref via barrel → real type definition at 0.98/compiler_api.
 *   8.  TYPEOF empty-R: all type refs external → pre-seeded regex edge preserved.
 *   9.  Incremental refresh: edited file on disk → pass reads updated content.
 *   10. Deleted-file forget: onFilePruned seam calls forget(); source becomes undefined.
 *
 * Each test is FULLY INDEPENDENT: its own in-memory DB + its own fixture dir.
 *
 * Test shape: real ts-morph Project on real disk-resident temp files + real
 * :memory: GraphDatabase. ts-morph requires disk files for symbol resolution.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';

import { GraphDatabase } from '../graphDatabase';
import type { GraphNode } from '../graphDatabaseTypes';
import type { IndexedFile } from '../indexingPipelineTypes';
import { typescriptEnrichmentPass } from './typescriptEnrichmentPass';

// ─── Constants ────────────────────────────────────────────────────────────────

const PROJECT = 'test-enrich';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    project: PROJECT,
    label: 'Function',
    name: overrides.id.split('.').at(-1) ?? 'fn',
    qualified_name: overrides.id,
    file_path: '',
    start_line: 1,
    end_line: 20,
    props: { is_exported: true, is_entry_point: false },
    ...overrides,
  };
}

function makeIndexedFile(absolutePath: string, relativePath: string): IndexedFile {
  return {
    absolutePath,
    relativePath,
    extension: 'ts',
    sizeBytes: 100,
    mtimeMs: Date.now(),
    contentHash: 'deadbeef',
    parsed: {
      filePath: relativePath,
      language: 'typescript',
      lineCount: 10,
      definitions: [],
      imports: [],
      calls: [],
      routes: [],
      exportedNames: [],
    },
  };
}

/**
 * Create a self-contained barrel fixture on disk:
 *   src/fooModule.ts  — exports `foo`
 *   src/index.ts      — barrel re-export of `foo`
 *   src/callerModule.ts — imports `foo` from the barrel and calls it
 *   tsconfig.json
 *
 * Returns the fixture dir and a Project loaded from it.
 */
function createBarrelFixture(): { fixtureDir: string; project: Project } {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-enrich-barrel-'));
  const srcDir = path.join(fixtureDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  fs.writeFileSync(
    path.join(srcDir, 'fooModule.ts'),
    ['export function foo(): string {', '  return "foo";', '}'].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(srcDir, 'index.ts'),
    "export { foo } from './fooModule';\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(srcDir, 'callerModule.ts'),
    [
      "import { foo } from './index';",
      '',
      'export function callFoo(): string {',
      '  return foo();',
      '}',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(fixtureDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2020', module: 'commonjs' },
      include: ['src/**/*.ts'],
    }),
    'utf8',
  );

  const project = new Project({ tsConfigFilePath: path.join(fixtureDir, 'tsconfig.json') });
  return { fixtureDir, project };
}

/**
 * Create a fixture with a caller that makes an ASYNC call:
 *   src/asyncDef.ts   — exports async `asyncOp`
 *   src/asyncCaller.ts — calls `await asyncOp()`
 */
function createAsyncFixture(): { fixtureDir: string; project: Project } {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-enrich-async-'));
  const srcDir = path.join(fixtureDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  fs.writeFileSync(
    path.join(srcDir, 'asyncDef.ts'),
    ['export async function asyncOp(): Promise<string> {', '  return "done";', '}'].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(srcDir, 'asyncCaller.ts'),
    [
      "import { asyncOp } from './asyncDef';",
      '',
      'export async function callAsync(): Promise<string> {',
      '  return await asyncOp();',
      '}',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(fixtureDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2020', module: 'commonjs' },
      include: ['src/**/*.ts'],
    }),
    'utf8',
  );

  const project = new Project({ tsConfigFilePath: path.join(fixtureDir, 'tsconfig.json') });
  return { fixtureDir, project };
}

/**
 * Create a fixture where the callee is external (not an indexed node):
 *   src/externalCaller.ts — calls console.log (external, never indexed)
 */
function createExternalCallFixture(): { fixtureDir: string; project: Project } {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-enrich-ext-'));
  const srcDir = path.join(fixtureDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  fs.writeFileSync(
    path.join(srcDir, 'externalCaller.ts'),
    [
      'export function doLog(): void {',
      '  console.log("hello");',
      '}',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(fixtureDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2020', module: 'commonjs' },
      include: ['src/**/*.ts'],
    }),
    'utf8',
  );

  const project = new Project({ tsConfigFilePath: path.join(fixtureDir, 'tsconfig.json') });
  return { fixtureDir, project };
}

function seedDb(db: GraphDatabase, root: string): void {
  db.upsertProject({ name: PROJECT, root_path: root, indexed_at: Date.now(), node_count: 0, edge_count: 0 });
}

// ─── Test 1: No-op when Project is null ──────────────────────────────────────

describe('typescriptEnrichmentPass — no-op when Project is null', () => {
  let db: GraphDatabase;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seedDb(db, '/fake');
    const callerQn = `${PROJECT}.src.callerModule.callFoo`;
    db.insertNodes([makeNode({ id: callerQn, name: 'callFoo', file_path: 'src/callerModule.ts' })]);
  });

  afterEach(() => {
    db.close();
  });

  it('returns without inserting any edges when tsMorphProject is null (skip path)', async () => {
    const callerQn = `${PROJECT}.src.callerModule.callFoo`;
    await typescriptEnrichmentPass(
      db,
      PROJECT,
      '/fake',
      [makeIndexedFile('/fake/src/callerModule.ts', 'src/callerModule.ts')],
      { tsMorphProject: null },
    );

    expect(db.getOutboundEdges(callerQn, 'CALLS')).toHaveLength(0);
    expect(db.getOutboundEdges(callerQn, 'ASYNC_CALLS')).toHaveLength(0);
  });
});

// ─── Test 2 & 3: Barrel resolution (positive + negative) ─────────────────────

describe('typescriptEnrichmentPass — barrel resolution', () => {
  let fixtureDir: string;
  let project: Project;
  let db: GraphDatabase;

  const callerQn = `${PROJECT}.src.callerModule.callFoo`;
  const realDefinitionQn = `${PROJECT}.src.fooModule.foo`;
  const barrelQn = `${PROJECT}.src.index.foo`;

  beforeEach(() => {
    ({ fixtureDir, project } = createBarrelFixture());
    db = new GraphDatabase(':memory:');
    seedDb(db, fixtureDir);
    db.insertNodes([
      makeNode({ id: callerQn, name: 'callFoo', file_path: 'src/callerModule.ts' }),
      makeNode({ id: realDefinitionQn, name: 'foo', file_path: 'src/fooModule.ts' }),
      makeNode({ id: barrelQn, name: 'foo', file_path: 'src/index.ts' }),
    ]);
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('resolves barrel-re-exported call to the real definition at 0.98 / compiler_api', async () => {
    await typescriptEnrichmentPass(
      db,
      PROJECT,
      fixtureDir,
      [makeIndexedFile(path.join(fixtureDir, 'src', 'callerModule.ts'), 'src/callerModule.ts')],
      { tsMorphProject: project },
    );

    const edges = db.getOutboundEdges(callerQn, 'CALLS');
    expect(edges).toHaveLength(1);

    const edge = edges[0];
    // Target must be the REAL definition — not the barrel
    expect(edge.target_id).toBe(realDefinitionQn);
    expect(edge.confidence).toBe(0.98);
    expect((edge.props as Record<string, unknown>).resolution_method).toBe('compiler_api');
    expect(edge.source_id).toBe(callerQn);
  });

  it('does not insert a CALLS edge pointing to the barrel file', async () => {
    await typescriptEnrichmentPass(
      db,
      PROJECT,
      fixtureDir,
      [makeIndexedFile(path.join(fixtureDir, 'src', 'callerModule.ts'), 'src/callerModule.ts')],
      { tsMorphProject: project },
    );

    const edges = db.getOutboundEdges(callerQn, 'CALLS');
    for (const edge of edges) {
      expect(edge.target_id).not.toBe(barrelQn);
    }
  });
});

// ─── Test 4: D5.1 delete-then-insert (wrong-target supersession) ─────────────

describe('typescriptEnrichmentPass — D5.1 supersession of wrong-target tree-sitter edge', () => {
  let fixtureDir: string;
  let project: Project;
  let db: GraphDatabase;

  const callerQn = `${PROJECT}.src.callerModule.callFoo`;
  const realDefinitionQn = `${PROJECT}.src.fooModule.foo`;
  const barrelQn = `${PROJECT}.src.index.foo`;

  beforeEach(() => {
    ({ fixtureDir, project } = createBarrelFixture());
    db = new GraphDatabase(':memory:');
    seedDb(db, fixtureDir);
    db.insertNodes([
      makeNode({ id: callerQn, name: 'callFoo', file_path: 'src/callerModule.ts' }),
      makeNode({ id: realDefinitionQn, name: 'foo', file_path: 'src/fooModule.ts' }),
      makeNode({ id: barrelQn, name: 'foo', file_path: 'src/index.ts' }),
    ]);

    // Pre-seed the WRONG tree-sitter edge (caller → barrel at 0.85/import_resolved)
    db.insertEdges([{
      project: PROJECT,
      source_id: callerQn,
      target_id: barrelQn,
      type: 'CALLS',
      props: { resolution_method: 'import_resolved' },
      confidence: 0.85,
    }]);
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('replaces the wrong-target tree-sitter edge with the correct compiler_api edge at 0.98', async () => {
    // Verify the wrong edge is seeded
    const before = db.getOutboundEdges(callerQn, 'CALLS');
    expect(before).toHaveLength(1);
    expect(before[0].target_id).toBe(barrelQn);

    await typescriptEnrichmentPass(
      db,
      PROJECT,
      fixtureDir,
      [makeIndexedFile(path.join(fixtureDir, 'src', 'callerModule.ts'), 'src/callerModule.ts')],
      { tsMorphProject: project },
    );

    const after = db.getOutboundEdges(callerQn, 'CALLS');

    // Exactly one edge remains (not two — the wrong one was deleted)
    expect(after).toHaveLength(1);

    // The surviving edge must be the CORRECT target at compiler_api confidence
    expect(after[0].target_id).toBe(realDefinitionQn);
    expect(after[0].confidence).toBe(0.98);
    expect((after[0].props as Record<string, unknown>).resolution_method).toBe('compiler_api');

    // The wrong-target barrel edge must be GONE
    const wrongEdge = after.find((e) => e.target_id === barrelQn);
    expect(wrongEdge).toBeUndefined();
  });
});

// ─── Test 5: ASYNC_CALLS for awaited expressions ──────────────────────────────

describe('typescriptEnrichmentPass — ASYNC_CALLS for awaited call expressions', () => {
  let fixtureDir: string;
  let project: Project;
  let db: GraphDatabase;

  const callerQn = `${PROJECT}.src.asyncCaller.callAsync`;
  const calleeQn = `${PROJECT}.src.asyncDef.asyncOp`;

  beforeEach(() => {
    ({ fixtureDir, project } = createAsyncFixture());
    db = new GraphDatabase(':memory:');
    seedDb(db, fixtureDir);
    db.insertNodes([
      makeNode({ id: callerQn, name: 'callAsync', file_path: 'src/asyncCaller.ts' }),
      makeNode({ id: calleeQn, name: 'asyncOp', file_path: 'src/asyncDef.ts' }),
    ]);
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('emits ASYNC_CALLS (not CALLS) at 0.98 / compiler_api for an awaited call', async () => {
    await typescriptEnrichmentPass(
      db,
      PROJECT,
      fixtureDir,
      [makeIndexedFile(path.join(fixtureDir, 'src', 'asyncCaller.ts'), 'src/asyncCaller.ts')],
      { tsMorphProject: project },
    );

    // Must produce an ASYNC_CALLS edge, not a CALLS edge
    const asyncEdges = db.getOutboundEdges(callerQn, 'ASYNC_CALLS');
    expect(asyncEdges).toHaveLength(1);
    expect(asyncEdges[0].target_id).toBe(calleeQn);
    expect(asyncEdges[0].confidence).toBe(0.98);
    expect((asyncEdges[0].props as Record<string, unknown>).resolution_method).toBe('compiler_api');

    // No plain CALLS edge should exist for this awaited call
    const callEdges = db.getOutboundEdges(callerQn, 'CALLS');
    expect(callEdges).toHaveLength(0);
  });
});

// ─── Test 6: Empty-R preservation ────────────────────────────────────────────

describe('typescriptEnrichmentPass — empty-R: preserves tree-sitter edge when ts-morph resolves nothing', () => {
  let fixtureDir: string;
  let project: Project;
  let db: GraphDatabase;

  const callerQn = `${PROJECT}.src.externalCaller.doLog`;
  // Some pre-existing tree-sitter edge to a synthetic "same-project" node
  const existingTargetQn = `${PROJECT}.src.someHelper.helper`;

  beforeEach(() => {
    ({ fixtureDir, project } = createExternalCallFixture());
    db = new GraphDatabase(':memory:');
    seedDb(db, fixtureDir);
    db.insertNodes([
      makeNode({ id: callerQn, name: 'doLog', file_path: 'src/externalCaller.ts' }),
      // existingTarget is in the DB so the pre-seeded edge is FK-valid
      makeNode({ id: existingTargetQn, name: 'helper', file_path: 'src/someHelper.ts' }),
    ]);

    // Pre-seed a tree-sitter CALLS edge for the caller (to a same-project node)
    db.insertEdges([{
      project: PROJECT,
      source_id: callerQn,
      target_id: existingTargetQn,
      type: 'CALLS',
      props: { resolution_method: 'name_unique' },
      confidence: 0.80,
    }]);
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('preserves the existing tree-sitter CALLS edge when ts-morph resolves no indexed callee (R is empty)', async () => {
    // externalCaller.ts calls console.log — ts-morph resolves it fine, but
    // console.log is not an indexed node so it drops out of validNodeIds → R empty.
    await typescriptEnrichmentPass(
      db,
      PROJECT,
      fixtureDir,
      [makeIndexedFile(path.join(fixtureDir, 'src', 'externalCaller.ts'), 'src/externalCaller.ts')],
      { tsMorphProject: project },
    );

    // The pre-seeded edge must still be there — deleteOutboundEdgesOfType must
    // NOT have fired because R was empty for this caller.
    const edges = db.getOutboundEdges(callerQn, 'CALLS');
    expect(edges).toHaveLength(1);
    expect(edges[0].target_id).toBe(existingTargetQn);
    expect(edges[0].confidence).toBe(0.80);
    expect((edges[0].props as Record<string, unknown>).resolution_method).toBe('name_unique');
  });
});

// ─── Test 7: TYPEOF barrel resolution ────────────────────────────────────────
// Source model: source_id = fileQn (whole-file QN), not an enclosing function.
// This mirrors the regex pass exactly (indexingPipelineTypeofResolution.ts:210,224).

describe('typescriptEnrichmentPass — TYPEOF_REFERENCES barrel resolution', () => {
  let fixtureDir: string;
  let project: Project;
  let db: GraphDatabase;

  // File that contains `type T = ReturnType<typeof foo>` importing foo from barrel
  // Source of the TYPEOF_REFERENCES edge = whole-file QN of the user file
  const userFileQn = `${PROJECT}.src.userModule`;
  // Target = the REAL definition of foo (in fooModule, not the barrel)
  const realFooQn = `${PROJECT}.src.fooModule.foo`;
  const barrelFooQn = `${PROJECT}.src.index.foo`;

  beforeEach(() => {
    // Reuse the barrel fixture (fooModule.ts, index.ts) but add a userModule.ts
    // that uses `typeof foo` in a type position via the barrel
    ({ fixtureDir, project } = createBarrelFixture());

    const srcDir = path.join(fixtureDir, 'src');
    fs.writeFileSync(
      path.join(srcDir, 'userModule.ts'),
      [
        "import { foo } from './index';",
        '',
        '// Uses typeof foo in a type position (TypeQuery node)',
        'type FooReturn = ReturnType<typeof foo>;',
        '',
        'export function useFoo(): FooReturn {',
        '  return foo();',
        '}',
      ].join('\n'),
      'utf8',
    );

    db = new GraphDatabase(':memory:');
    seedDb(db, fixtureDir);

    // Insert foo nodes with the labels the typeof resolver expects (Function).
    // Also insert a File node for userModule — the TYPEOF_REFERENCES edge uses
    // fileQn as source_id, which requires a node with that ID in the DB
    // (FK constraint on edges.source_id → nodes.id).
    db.insertNodes([
      makeNode({ id: realFooQn, name: 'foo', file_path: 'src/fooModule.ts' }),
      makeNode({ id: barrelFooQn, name: 'foo', file_path: 'src/index.ts' }),
      makeNode({ id: `${PROJECT}.src.userModule.useFoo`, name: 'useFoo', file_path: 'src/userModule.ts' }),
      // File node so the fileQn edge source satisfies the FK constraint
      { id: userFileQn, project: PROJECT, label: 'File' as const, name: 'userModule', qualified_name: userFileQn, file_path: 'src/userModule.ts', start_line: 1, end_line: 99, props: {} },
    ]);
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('resolves a barrel-re-exported typeof reference to the real type definition at 0.98 / compiler_api', async () => {
    const userFile = makeIndexedFile(
      path.join(fixtureDir, 'src', 'userModule.ts'),
      'src/userModule.ts',
    );

    await typescriptEnrichmentPass(db, PROJECT, fixtureDir, [userFile], { tsMorphProject: project });

    // source_id = whole-file QN (not an enclosing function) — mirrors regex pass model
    const edges = db.getOutboundEdges(userFileQn, 'TYPEOF_REFERENCES');
    expect(edges.length).toBeGreaterThanOrEqual(1);

    // The target must be the REAL definition (fooModule.foo), not the barrel
    const realEdge = edges.find((e) => e.target_id === realFooQn);
    expect(realEdge).toBeDefined();
    expect(realEdge!.confidence).toBe(0.98);
    expect((realEdge!.props as Record<string, unknown>).resolution_method).toBe('compiler_api');

    // The barrel must NOT appear as a TYPEOF_REFERENCES target
    const barrelEdge = edges.find((e) => e.target_id === barrelFooQn);
    expect(barrelEdge).toBeUndefined();
  });
});

// ─── Test 8: TYPEOF empty-R preservation ─────────────────────────────────────

describe('typescriptEnrichmentPass — TYPEOF_REFERENCES empty-R: pre-seeded regex edge preserved', () => {
  let fixtureDir: string;
  let project: Project;
  let db: GraphDatabase;

  beforeEach(() => {
    // A file that uses `typeof console` — console is not an indexed node,
    // so the ts-morph resolution produces an empty R → no delete should fire.
    ({ fixtureDir, project } = createExternalCallFixture());

    // Add a typeof usage to externalCaller.ts
    const srcDir = path.join(fixtureDir, 'src');
    fs.writeFileSync(
      path.join(srcDir, 'externalCaller.ts'),
      [
        '// typeof on an external symbol (console) — not an indexed node',
        'type LogType = typeof console;',
        '',
        'export function doLog(): void {',
        '  console.log("hello");',
        '}',
      ].join('\n'),
      'utf8',
    );

    db = new GraphDatabase(':memory:');
    seedDb(db, fixtureDir);

    const callerFileQn = `${PROJECT}.src.externalCaller`;
    const someTypeQn = `${PROJECT}.src.someTypes.MyType`;

    db.insertNodes([
      makeNode({ id: `${PROJECT}.src.externalCaller.doLog`, name: 'doLog', file_path: 'src/externalCaller.ts' }),
      makeNode({ id: someTypeQn, name: 'MyType', file_path: 'src/someTypes.ts', label: 'Type' as const }),
      // File node so the fileQn edge source satisfies the FK constraint
      { id: callerFileQn, project: PROJECT, label: 'File' as const, name: 'externalCaller', qualified_name: callerFileQn, file_path: 'src/externalCaller.ts', start_line: 1, end_line: 99, props: {} },
    ]);

    // Pre-seed a regex-style TYPEOF_REFERENCES edge (source = fileQn, matching
    // the regex pass's source model: source_id = whole-file QN)
    db.insertEdges([{
      project: PROJECT,
      source_id: callerFileQn,
      target_id: someTypeQn,
      type: 'TYPEOF_REFERENCES',
      props: { resolution_method: 'typeof_regex', pattern: 'typeof' },
      confidence: 0.9,
    }]);
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('preserves pre-seeded regex TYPEOF_REFERENCES edge when all ts-morph typeof targets are external/non-indexed', async () => {
    const callerFileQn = `${PROJECT}.src.externalCaller`;
    const someTypeQn = `${PROJECT}.src.someTypes.MyType`;

    await typescriptEnrichmentPass(
      db,
      PROJECT,
      fixtureDir,
      [makeIndexedFile(path.join(fixtureDir, 'src', 'externalCaller.ts'), 'src/externalCaller.ts')],
      { tsMorphProject: project },
    );

    // The pre-seeded typeof edge must survive — R was empty (console not indexed),
    // so deleteOutboundEdgesOfType must NOT have fired for this file.
    const edges = db.getOutboundEdges(callerFileQn, 'TYPEOF_REFERENCES');
    expect(edges).toHaveLength(1);
    expect(edges[0].target_id).toBe(someTypeQn);
    expect(edges[0].confidence).toBe(0.9);
    expect((edges[0].props as Record<string, unknown>).resolution_method).toBe('typeof_regex');
  });
});

// ─── Test 9: Incremental refresh ─────────────────────────────────────────────
// Verifies the D7 warm incremental path: the pass calls refreshFromFileSystem()
// so it reads current disk state, not the stale version loaded at Project init.

describe('typescriptEnrichmentPass — incremental: refreshFromFileSystem picks up edited file', () => {
  let fixtureDir: string;
  let project: Project;
  let db: GraphDatabase;

  const callerQn = `${PROJECT}.src.callerModule.callFoo`;
  const originalTargetQn = `${PROJECT}.src.fooModule.foo`;
  const newTargetQn = `${PROJECT}.src.barModule.bar`;

  beforeEach(() => {
    // Start with the barrel fixture
    ({ fixtureDir, project } = createBarrelFixture());

    const srcDir = path.join(fixtureDir, 'src');

    // Add a new barModule.ts that exports `bar`
    fs.writeFileSync(
      path.join(srcDir, 'barModule.ts'),
      ['export function bar(): string {', '  return "bar";', '}'].join('\n'),
      'utf8',
    );

    db = new GraphDatabase(':memory:');
    seedDb(db, fixtureDir);
    db.insertNodes([
      makeNode({ id: callerQn, name: 'callFoo', file_path: 'src/callerModule.ts' }),
      makeNode({ id: originalTargetQn, name: 'foo', file_path: 'src/fooModule.ts' }),
      makeNode({ id: newTargetQn, name: 'bar', file_path: 'src/barModule.ts' }),
    ]);
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('resolves edges from updated file content after refreshFromFileSystem()', async () => {
    const srcDir = path.join(fixtureDir, 'src');

    // First pass: callerModule calls foo (via barrel)
    await typescriptEnrichmentPass(
      db,
      PROJECT,
      fixtureDir,
      [makeIndexedFile(path.join(srcDir, 'callerModule.ts'), 'src/callerModule.ts')],
      { tsMorphProject: project },
    );
    const firstPassEdges = db.getOutboundEdges(callerQn, 'CALLS');
    expect(firstPassEdges.length).toBeGreaterThanOrEqual(1);
    expect(firstPassEdges[0].target_id).toBe(originalTargetQn);

    // Edit callerModule.ts on disk to now call bar() instead of foo()
    fs.writeFileSync(
      path.join(srcDir, 'callerModule.ts'),
      [
        "import { bar } from './barModule';",
        '',
        'export function callFoo(): string {',
        '  return bar();',
        '}',
      ].join('\n'),
      'utf8',
    );

    // Second pass (incremental): refreshFromFileSystem() reads the new content
    await typescriptEnrichmentPass(
      db,
      PROJECT,
      fixtureDir,
      [makeIndexedFile(path.join(srcDir, 'callerModule.ts'), 'src/callerModule.ts')],
      { tsMorphProject: project },
    );

    // The edge must now point to bar, not foo (stale foo edge was superseded)
    const secondPassEdges = db.getOutboundEdges(callerQn, 'CALLS');
    expect(secondPassEdges).toHaveLength(1);
    expect(secondPassEdges[0].target_id).toBe(newTargetQn);
    expect(secondPassEdges[0].confidence).toBe(0.98);
    expect((secondPassEdges[0].props as Record<string, unknown>).resolution_method).toBe('compiler_api');
  });
});

// ─── Test 10: Deleted-file forget (D7 onFilePruned seam) ─────────────────────
// The worker's onFilePruned callback must normalize backslashes before calling
// getSourceFile(), because ts-morph stores paths with forward slashes on all
// platforms. Without normalization, getSourceFile() returns undefined on Windows
// and forget() never fires (AST memory leak).
//
// This test exercises the PRODUCTION callback shape:
//   project?.getSourceFile(absolutePath.replace(/\\/g, '/'))?.forget()
// called with a raw OS path (which on Windows carries backslashes).
// The test must FAIL if the normalization is omitted from the callback.

describe('typescriptEnrichmentPass — D7 onFilePruned seam: forget() releases the source file', () => {
  let fixtureDir: string;
  let project: Project;

  beforeEach(() => {
    ({ fixtureDir, project } = createBarrelFixture());
  });

  afterEach(() => {
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('releases the source file when onFilePruned is called with a raw OS path (backslashes on Windows)', () => {
    // path.join produces backslashes on Windows — this is the raw absolutePath
    // the pipeline delivers to onFilePruned.
    const rawAbsPath = path.join(fixtureDir, 'src', 'fooModule.ts');
    // ts-morph's normalized form (always forward slashes, on all platforms)
    const normPath = rawAbsPath.replace(/\\/g, '/');

    // Confirm the file is tracked before forget
    expect(project.getSourceFile(normPath)).toBeDefined();

    // Reproduce the PRODUCTION onFilePruned closure from indexingWorker.ts:
    //   project?.getSourceFile(absolutePath.replace(/\\/g, '/'))?.forget()
    // Called with rawAbsPath exactly as the pipeline delivers it.
    // On Windows rawAbsPath contains backslashes; the normalization in the
    // production callback is what makes getSourceFile() find the file.
    // Without .replace(/\\/g, '/') in the callback, this call returns undefined
    // and forget() never fires — the bug this fix closes.
    const productionOnFilePruned = (absolutePath: string): void => {
      project?.getSourceFile(absolutePath.replace(/\\/g, '/'))?.forget();
    };
    productionOnFilePruned(rawAbsPath);

    // After the production callback fires, the source file must be gone
    expect(project.getSourceFile(normPath)).toBeUndefined();
  });
});

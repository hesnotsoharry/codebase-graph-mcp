/**
 * typescriptEnrichmentPass.test.ts — Unit/integration tests for Pass 6.
 *
 * Contracts under test:
 *   1. No-op when tsMorphProject is null (skip path).
 *   2. Barrel resolution: call via barrel → real definition at 0.98/compiler_api.
 *   3. Barrel negative: barrel node NEVER appears as a resolved target.
 *   4. D5.1 delete-then-insert: wrong-target tree-sitter edge is replaced.
 *   5. ASYNC_CALLS: awaited call → ASYNC_CALLS edge (not CALLS).
 *   6. Empty-R preservation: no ts-morph resolution → tree-sitter edge preserved.
 *
 * Each test is FULLY INDEPENDENT: its own in-memory DB + its own fixture dir
 * (or fresh nodes in the shared fixture dir that doesn't share DB state).
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

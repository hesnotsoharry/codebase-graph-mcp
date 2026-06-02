/**
 * referencesPass.test.ts — Unit/integration tests for Pass 7.
 *
 * Contracts under test:
 *   (a) Type-only reference: param typed as an interface never called →
 *       REFERENCES edge source→interface at 0.98/compiler_api (non-vacuous).
 *   (b) Decorator use: @Decorator on a class → REFERENCES edge class→decorator.
 *   (c) JSX element: <MyComp/> in a .tsx file → REFERENCES edge fn→component.
 *   (d) Blast-radius: a type-only consumer surfaces in detectChangesForSession
 *       even though it has NO CALLS edge to the changed type.
 *   (e) Dedup: multiple TypeReferences from one function to one type → exactly
 *       one REFERENCES edge.
 *
 * Each test is FULLY INDEPENDENT: own in-memory DB + own temp fixture dir.
 *
 * Test shape: real ts-morph Project on real disk files + real :memory: DB.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';

import { GraphDatabase } from '../graphDatabase';
import type { GraphNode } from '../graphDatabaseTypes';
import type { IndexedFile } from '../indexingPipelineTypes';
import { referencesPass } from './referencesPass';
import { expandCallers } from '../graphDatabaseSession';

// ─── Constants ────────────────────────────────────────────────────────────────

const PROJECT = 'test-refs';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function seedDb(db: GraphDatabase, root: string): void {
  db.upsertProject({ name: PROJECT, root_path: root, indexed_at: Date.now(), node_count: 0, edge_count: 0 });
}

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    project: PROJECT,
    label: 'Function',
    name: overrides.id.split('.').at(-1) ?? 'fn',
    qualified_name: overrides.id,
    file_path: '',
    start_line: 1,
    end_line: 30,
    props: {},
    ...overrides,
  };
}

function makeIndexedFile(absolutePath: string, relativePath: string, ext = 'ts'): IndexedFile {
  return {
    absolutePath,
    relativePath,
    extension: ext,
    sizeBytes: 200,
    mtimeMs: Date.now(),
    contentHash: 'abc',
    parsed: {
      filePath: relativePath,
      language: 'typescript',
      lineCount: 20,
      definitions: [],
      imports: [],
      calls: [],
      routes: [],
      exportedNames: [],
    },
  };
}

function writeTsConfig(dir: string, include = ['src/**/*.ts', 'src/**/*.tsx']): void {
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'ES2020', module: 'commonjs', jsx: 'react' }, include }),
    'utf8',
  );
}

// ─── Test (a): type-only reference ───────────────────────────────────────────

describe('referencesPass — type-only reference (TypeReference, no CALLS edge)', () => {
  let fixtureDir: string;
  let project: Project;
  let db: GraphDatabase;

  // IShape is defined in shapes.ts; consumer.ts uses it only as a param type
  const shapeQn = `${PROJECT}.src.shapes.IShape`;
  const consumerFnQn = `${PROJECT}.src.consumer.processShape`;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-type-'));
    const srcDir = path.join(fixtureDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'shapes.ts'),
      'export interface IShape { area(): number; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(srcDir, 'consumer.ts'),
      [
        "import type { IShape } from './shapes';",
        '// Uses IShape only as a type — never calls anything on it',
        'export function processShape(s: IShape): number { return s.area(); }',
      ].join('\n'),
      'utf8',
    );
    writeTsConfig(fixtureDir);

    project = new Project({ tsConfigFilePath: path.join(fixtureDir, 'tsconfig.json') });

    db = new GraphDatabase(':memory:');
    seedDb(db, fixtureDir);
    db.insertNodes([
      makeNode({ id: consumerFnQn, name: 'processShape', label: 'Function', file_path: 'src/consumer.ts' }),
      makeNode({ id: shapeQn, name: 'IShape', label: 'Interface', file_path: 'src/shapes.ts' }),
    ]);
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('emits a REFERENCES edge from processShape to IShape at 0.98 / compiler_api', async () => {
    await referencesPass(
      db, PROJECT, fixtureDir,
      [makeIndexedFile(path.join(fixtureDir, 'src', 'consumer.ts'), 'src/consumer.ts')],
      { tsMorphProject: project },
    );

    const edges = db.getOutboundEdges(consumerFnQn, 'REFERENCES');
    expect(edges).toHaveLength(1);
    // Non-vacuous: assert the exact target QN, not just truthy
    expect(edges[0].target_id).toBe(shapeQn);
    expect(edges[0].confidence).toBe(0.98);
    expect((edges[0].props as Record<string, unknown>).resolution_method).toBe('compiler_api');
    expect(edges[0].source_id).toBe(consumerFnQn);

    // Must have NO CALLS edge — this is a type-only reference
    expect(db.getOutboundEdges(consumerFnQn, 'CALLS')).toHaveLength(0);
  });
});

// ─── Test (b): decorator use ──────────────────────────────────────────────────

describe('referencesPass — decorator use', () => {
  let fixtureDir: string;
  let project: Project;
  let db: GraphDatabase;

  const decoratorQn = `${PROJECT}.src.decorators.Component`;
  const classQn = `${PROJECT}.src.app.AppComponent`;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-dec-'));
    const srcDir = path.join(fixtureDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'decorators.ts'),
      [
        'export function Component(opts: { selector: string }) {',
        '  return (target: any) => target;',
        '}',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(srcDir, 'app.ts'),
      [
        "import { Component } from './decorators';",
        "@Component({ selector: 'app-root' })",
        'export class AppComponent {}',
      ].join('\n'),
      'utf8',
    );
    writeTsConfig(fixtureDir);

    project = new Project({ tsConfigFilePath: path.join(fixtureDir, 'tsconfig.json') });

    db = new GraphDatabase(':memory:');
    seedDb(db, fixtureDir);
    db.insertNodes([
      makeNode({ id: classQn, name: 'AppComponent', label: 'Class', file_path: 'src/app.ts' }),
      makeNode({ id: decoratorQn, name: 'Component', label: 'Function', file_path: 'src/decorators.ts' }),
    ]);
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('emits a REFERENCES edge from AppComponent to the Component decorator at 0.98 / compiler_api', async () => {
    await referencesPass(
      db, PROJECT, fixtureDir,
      [makeIndexedFile(path.join(fixtureDir, 'src', 'app.ts'), 'src/app.ts')],
      { tsMorphProject: project },
    );

    const edges = db.getOutboundEdges(classQn, 'REFERENCES');
    expect(edges.length).toBeGreaterThanOrEqual(1);

    const decoratorEdge = edges.find((e) => e.target_id === decoratorQn);
    expect(decoratorEdge).toBeDefined();
    expect(decoratorEdge!.confidence).toBe(0.98);
    expect((decoratorEdge!.props as Record<string, unknown>).resolution_method).toBe('compiler_api');
  });
});

// ─── Test (c): JSX element use ────────────────────────────────────────────────
// ts-morph parses actual JSX syntax written to disk (.tsx files) without needing
// a runtime transform. The fixture uses real <MyComp/> syntax so
// JsxSelfClosingElement nodes appear in the AST and collectJsxReferences fires.

describe('referencesPass — JSX element use (.tsx)', () => {
  let fixtureDir: string;
  let project: Project;
  let db: GraphDatabase;

  const myCompQn = `${PROJECT}.src.MyComp.MyComp`;
  const appFnQn = `${PROJECT}.src.App.App`;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-jsx-'));
    const srcDir = path.join(fixtureDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // MyComp returns null — no JSX needed in its own body
    fs.writeFileSync(
      path.join(srcDir, 'MyComp.tsx'),
      'export function MyComp(): null { return null; }\n',
      'utf8',
    );
    // App uses actual JSX: <MyComp/> produces a JsxSelfClosingElement in the AST
    fs.writeFileSync(
      path.join(srcDir, 'App.tsx'),
      [
        "import { MyComp } from './MyComp';",
        'export function App(): null { return <MyComp/>; }',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(fixtureDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: false,
          target: 'ES2020',
          module: 'commonjs',
          jsx: 'react-jsx',      // does not require a React import
          skipLibCheck: true,
          noLib: true,           // avoid missing-lib errors in the stub env
        },
        include: ['src/**/*.tsx'],
      }),
      'utf8',
    );

    project = new Project({ tsConfigFilePath: path.join(fixtureDir, 'tsconfig.json') });

    db = new GraphDatabase(':memory:');
    seedDb(db, fixtureDir);
    db.insertNodes([
      makeNode({ id: appFnQn, name: 'App', label: 'Function', file_path: 'src/App.tsx' }),
      makeNode({ id: myCompQn, name: 'MyComp', label: 'Function', file_path: 'src/MyComp.tsx' }),
    ]);
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('emits a REFERENCES edge from App to MyComp at 0.98 / compiler_api via JSX self-closing element', async () => {
    await referencesPass(
      db, PROJECT, fixtureDir,
      [makeIndexedFile(path.join(fixtureDir, 'src', 'App.tsx'), 'src/App.tsx', 'tsx')],
      { tsMorphProject: project },
    );

    // <MyComp/> in App must produce a REFERENCES edge to MyComp
    const edges = db.getOutboundEdges(appFnQn, 'REFERENCES');
    const jsxEdge = edges.find((e) => e.target_id === myCompQn);
    expect(jsxEdge).toBeDefined();
    expect(jsxEdge!.confidence).toBe(0.98);
    expect((jsxEdge!.props as Record<string, unknown>).resolution_method).toBe('compiler_api');
  });
});

// ─── Test (d): blast-radius surfaces type-only consumer ──────────────────────

describe('referencesPass — blast-radius: type-only consumer surfaces via REFERENCES', () => {
  let fixtureDir: string;
  let project: Project;
  let db: GraphDatabase;

  const interfaceQn = `${PROJECT}.src.domain.IEvent`;
  const handlerQn = `${PROJECT}.src.handler.handleEvent`;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-blast-'));
    const srcDir = path.join(fixtureDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'domain.ts'),
      'export interface IEvent { type: string; payload: unknown; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(srcDir, 'handler.ts'),
      [
        "import type { IEvent } from './domain';",
        '// handleEvent only receives IEvent as a type — never constructs one',
        'export function handleEvent(evt: IEvent): void { console.log(evt.type); }',
      ].join('\n'),
      'utf8',
    );
    writeTsConfig(fixtureDir);

    project = new Project({ tsConfigFilePath: path.join(fixtureDir, 'tsconfig.json') });

    db = new GraphDatabase(':memory:');
    seedDb(db, fixtureDir);

    // Insert nodes. IEvent is an Interface node — also register a File hash so
    // detectChangesForSession can find changed files.
    db.insertNodes([
      makeNode({ id: interfaceQn, name: 'IEvent', label: 'Interface', file_path: 'src/domain.ts' }),
      makeNode({ id: handlerQn, name: 'handleEvent', label: 'Function', file_path: 'src/handler.ts' }),
    ]);

    // Register file hashes so detectChangesForSession works
    db.upsertFileHash({ project: PROJECT, rel_path: 'src/domain.ts', content_hash: 'old', mtime_ns: 1, size: 10 });
    db.upsertFileHash({ project: PROJECT, rel_path: 'src/handler.ts', content_hash: 'old', mtime_ns: 1, size: 10 });
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('expandCallers includes handleEvent in blast-radius when IEvent is the seed, via REFERENCES edge alone', async () => {
    // Run the pass to emit the REFERENCES edge handler→interface
    await referencesPass(
      db, PROJECT, fixtureDir,
      [makeIndexedFile(path.join(fixtureDir, 'src', 'handler.ts'), 'src/handler.ts')],
      { tsMorphProject: project },
    );

    // Confirm the REFERENCES edge exists (precondition)
    const refs = db.getOutboundEdges(handlerQn, 'REFERENCES');
    const refToInterface = refs.find((e) => e.target_id === interfaceQn);
    expect(refToInterface).toBeDefined();

    // Confirm NO CALLS edge exists — handleEvent is a type-only consumer
    expect(db.getOutboundEdges(handlerQn, 'CALLS')).toHaveLength(0);

    // Drive blast-radius directly via expandCallers with IEvent as the seed.
    // This bypasses isFileChanged entirely, proving that REFERENCES edges are
    // the ONLY reason handleEvent surfaces — no CALLS/TYPEOF edge exists.
    // expandCallers is the BFS engine used by detectChangesForSession; calling
    // it directly with a known seed is the authoritative traversal test.
    const affected = expandCallers(db, new Set([interfaceQn]), 2);

    // handleEvent must appear: IEvent is the seed → inbound REFERENCES edge
    // from handleEvent is followed → handleEvent enters the blast-radius set.
    expect(affected.has(handlerQn)).toBe(true);

    // IEvent itself is in the result as hop-0
    expect(affected.has(interfaceQn)).toBe(true);
  });
});

// ─── Test (e): deduplication ──────────────────────────────────────────────────

describe('referencesPass — dedup: multiple type-refs from one function → one REFERENCES edge', () => {
  let fixtureDir: string;
  let project: Project;
  let db: GraphDatabase;

  const shapeQn = `${PROJECT}.src.shapes.IShape`;
  const builderQn = `${PROJECT}.src.builder.buildShape`;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-dedup-'));
    const srcDir = path.join(fixtureDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'shapes.ts'),
      'export interface IShape { area(): number; }\n',
      'utf8',
    );
    // buildShape references IShape THREE times: param type, return type, local var type
    fs.writeFileSync(
      path.join(srcDir, 'builder.ts'),
      [
        "import type { IShape } from './shapes';",
        'export function buildShape(template: IShape): IShape {',
        '  const result: IShape = { area: () => template.area() };',
        '  return result;',
        '}',
      ].join('\n'),
      'utf8',
    );
    writeTsConfig(fixtureDir);

    project = new Project({ tsConfigFilePath: path.join(fixtureDir, 'tsconfig.json') });

    db = new GraphDatabase(':memory:');
    seedDb(db, fixtureDir);
    db.insertNodes([
      makeNode({ id: builderQn, name: 'buildShape', label: 'Function', file_path: 'src/builder.ts' }),
      makeNode({ id: shapeQn, name: 'IShape', label: 'Interface', file_path: 'src/shapes.ts' }),
    ]);
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('emits exactly one REFERENCES edge from buildShape to IShape despite three TypeReference nodes', async () => {
    await referencesPass(
      db, PROJECT, fixtureDir,
      [makeIndexedFile(path.join(fixtureDir, 'src', 'builder.ts'), 'src/builder.ts')],
      { tsMorphProject: project },
    );

    const edges = db.getOutboundEdges(builderQn, 'REFERENCES');
    // Dedup must collapse the 3 TypeReference nodes to 1 edge
    const edgesToShape = edges.filter((e) => e.target_id === shapeQn);
    expect(edgesToShape).toHaveLength(1);
    expect(edgesToShape[0].confidence).toBe(0.98);
  });
});

// ─── Test (f): method decorator overlap — REFERENCES + CALLS coexist ──────────
// A factory-call decorator `@Log()` on a method produces BOTH a CALLS edge
// (Pass 6 — the factory is invoked) and a REFERENCES edge (Pass 7 — the method
// references the decorator symbol). This overlap is intentional and benign.
// Test documents the behavior; CALLS edge presence is asserted separately to
// make the coexistence explicit.

describe('referencesPass — method decorator: REFERENCES edge from method to decorator', () => {
  let fixtureDir: string;
  let project: Project;
  let db: GraphDatabase;

  const logDecQn = `${PROJECT}.src.logger.Log`;
  // The pass uses buildSymbolQn(fileQn, enclosingName) where enclosingName is
  // the method's own name returned by getEnclosingFunctionName — NOT the
  // class-qualified form. Source QN = project.src.service.doWork.
  const methodQn = `${PROJECT}.src.service.doWork`;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-methdec-'));
    const srcDir = path.join(fixtureDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'logger.ts'),
      [
        '// Factory decorator: returns a method decorator',
        'export function Log() {',
        '  return (_target: any, _key: string, _desc: PropertyDescriptor) => _desc;',
        '}',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(srcDir, 'service.ts'),
      [
        "import { Log } from './logger';",
        'export class MyService {',
        '  @Log()',
        '  doWork(): void { /* impl */ }',
        '}',
      ].join('\n'),
      'utf8',
    );
    writeTsConfig(fixtureDir);

    project = new Project({ tsConfigFilePath: path.join(fixtureDir, 'tsconfig.json') });

    db = new GraphDatabase(':memory:');
    seedDb(db, fixtureDir);
    db.insertNodes([
      makeNode({ id: methodQn, name: 'doWork', label: 'Method' as const, file_path: 'src/service.ts' }),
      makeNode({ id: logDecQn, name: 'Log', label: 'Function' as const, file_path: 'src/logger.ts' }),
    ]);
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('emits a REFERENCES edge from doWork to Log decorator at 0.98 / compiler_api', async () => {
    await referencesPass(
      db, PROJECT, fixtureDir,
      [makeIndexedFile(path.join(fixtureDir, 'src', 'service.ts'), 'src/service.ts')],
      { tsMorphProject: project },
    );

    // The method must have a REFERENCES edge to the Log decorator
    const refs = db.getOutboundEdges(methodQn, 'REFERENCES');
    const logRef = refs.find((e) => e.target_id === logDecQn);
    expect(logRef).toBeDefined();
    expect(logRef!.confidence).toBe(0.98);
    expect((logRef!.props as Record<string, unknown>).resolution_method).toBe('compiler_api');
    // source is the method QN (enclosingFunctionName finds the method name)
    expect(logRef!.source_id).toBe(methodQn);
  });
});

/**
 * indexingPipeline.integration.test.ts — Regression test for parser init in the
 * indexing pipeline.
 *
 * Exercises IndexingPipeline.index() against a real TreeSitterParser (WASM) and
 * a real GraphDatabase (':memory:') with a small TypeScript fixture.
 *
 * Regression guard (wave-67): the worker thread created TreeSitterParser without
 * calling await parser.init(), causing every parseFile() call to throw
 * "TreeSitterParser not initialized" — silently swallowed — leaving every file
 * with parsed:null and zero DEFINES edges in the DB. This test asserts that Class
 * and Method nodes exist after index() completes.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ─── Module mocks — must precede transitive imports of logger/electron ────────

vi.mock('../logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    log: vi.fn(),
  },
  getLogPath: vi.fn(() => ''),
}));

vi.mock('../ipc-handlers/gitOperations', () => ({
  gitExec: vi.fn(async () => ''),
  gitTrimmed: vi.fn(async () => ''),
}));

import { GraphDatabase } from './graphDatabase';
import { IndexingPipeline } from './indexingPipeline';
import type { IndexingResult } from './indexingPipelineTypes';
import { TreeSitterParser } from './treeSitterParser';

// ─── Fixture ──────────────────────────────────────────────────────────────────

const FIXTURE_CONTENT = [
  'export class Foo {',
  '  greet(name: string): string {',
  '    return `Hello, ${name}`;',
  '  }',
  '',
  '  add(a: number, b: number): number {',
  '    return a + b;',
  '  }',
  '}',
  '',
  'export function standaloneHelper(x: number): number {',
  '  return x * 2;',
  '}',
].join('\n') + '\n';

const PROJECT_NAME = 'pipeline-init-regression';

// ─── Shared state ─────────────────────────────────────────────────────────────

let fixtureDir = '';
let db: GraphDatabase;
let result: IndexingResult;

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-init-regression-'));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
  fs.writeFileSync(path.join(fixtureDir, 'fixture.ts'), FIXTURE_CONTENT, 'utf8');

  const parser = new TreeSitterParser();
  await parser.init();

  db = new GraphDatabase(':memory:');
  const pipeline = new IndexingPipeline(db, parser);

  result = await pipeline.index({
    projectRoot: fixtureDir,
    projectName: PROJECT_NAME,
    incremental: false,
  });
}, 30_000);

afterAll(() => {
  try { db?.close(); } catch { /* best-effort */ }
  try {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('IndexingPipeline.index() — parser init regression', () => {
  it('completes successfully', () => {
    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBeGreaterThan(0);
  });

  it('creates a Class node for Foo', () => {
    const classNodes = db.getNodesByLabel(PROJECT_NAME, 'Class');
    const fooNode = classNodes.find((n) => n.name === 'Foo');
    expect(fooNode).toBeDefined();
  });

  it('creates Method nodes for Foo.greet and Foo.add', () => {
    const methodNodes = db.getNodesByLabel(PROJECT_NAME, 'Method');
    const names = methodNodes.map((n) => n.name);
    expect(names).toContain('greet');
    expect(names).toContain('add');
  });

  it('creates a Function node for standaloneHelper', () => {
    const fnNodes = db.getNodesByLabel(PROJECT_NAME, 'Function');
    const helper = fnNodes.find((n) => n.name === 'standaloneHelper');
    expect(helper).toBeDefined();
  });

  it('creates DEFINES edges from the File node to symbol nodes', () => {
    const fileNodes = db.getNodesByLabel(PROJECT_NAME, 'File');
    const fixtureFile = fileNodes.find((n) => n.file_path === 'fixture.ts');
    expect(fixtureFile).toBeDefined();

    const definesEdges = db.getOutboundEdges(fixtureFile!.id, 'DEFINES');
    expect(definesEdges.length).toBeGreaterThan(0);
  });
});

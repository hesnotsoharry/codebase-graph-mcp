/**
 * indexingPipelinePasses.test.ts — Unit tests for parsePass per-file error isolation
 * and definitionPass heritage edge emission (Wave 21 Phase 1).
 *
 * parsePass: verifies that a parse exception on one file does not abort the whole run.
 * definitionPass heritage: verifies IMPLEMENTS+EXTENDS edge emission with symbolsByName
 * resolution — happy path (resolves) + skip path (unresolved target).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphDatabase } from './graphDatabase';
import { definitionPass, parsePass } from './indexingPipelinePasses';
import type { DiscoveredFile, IndexedFile } from './indexingPipelineTypes';
import type { TreeSitterParser } from './treeSitterParser';
import type { ExtractedDefinition } from './treeSitterTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(relativePath: string): DiscoveredFile {
  return {
    absolutePath: `/tmp/${relativePath}`,
    relativePath,
    extension: relativePath.split('.').pop() ?? 'ts',
    sizeBytes: 100,
    mtimeMs: Date.now(),
  };
}

function makeParsedResult(filePath: string) {
  return {
    filePath,
    language: 'typescript' as const,
    lineCount: 10,
    definitions: [],
    imports: [],
    calls: [],
    routes: [],
    exportedNames: [],
  };
}

// Mock fs/promises so no real disk I/O occurs
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn().mockResolvedValue('const x = 1'),
  },
  readFile: vi.fn().mockResolvedValue('const x = 1'),
}));

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parsePass — per-file error isolation', () => {
  it('returns all files even when one throws during parsing', async () => {
    const files = [makeFile('src/good.ts'), makeFile('src/bad.ts'), makeFile('src/also-good.ts')];

    const parser = {
      parseFile: vi.fn().mockImplementation((relPath: string) => {
        if (relPath === 'src/bad.ts') throw new Error('WASM exploded');
        return Promise.resolve(makeParsedResult(relPath));
      }),
    } as unknown as TreeSitterParser;

    const results = await parsePass(parser, files);

    expect(results).toHaveLength(3);
    expect(results[1].relativePath).toBe('src/bad.ts');
    expect(results[1].parsed).toBeNull();
    // contentHash is computed before parse — non-empty because the read succeeded
    expect(results[1].contentHash).not.toBe('');
  });

  it('good files adjacent to the bad file still have parsed results', async () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')];

    const parser = {
      parseFile: vi.fn().mockImplementation((relPath: string) => {
        if (relPath === 'src/b.ts') throw new Error('parse error');
        return Promise.resolve(makeParsedResult(relPath));
      }),
    } as unknown as TreeSitterParser;

    const results = await parsePass(parser, files);

    expect(results[0].parsed).not.toBeNull();
    expect(results[1].parsed).toBeNull();
  });

  it('invokes onProgress callback at completion', async () => {
    const files = [makeFile('src/x.ts')];
    const parser = {
      parseFile: vi.fn().mockResolvedValue(makeParsedResult('src/x.ts')),
    } as unknown as TreeSitterParser;

    const onProgress = vi.fn();
    await parsePass(parser, files, onProgress);
    expect(onProgress).toHaveBeenCalledWith(1, 1);
  });

  it('handles empty file list', async () => {
    const parser = {
      parseFile: vi.fn(),
    } as unknown as TreeSitterParser;

    const results = await parsePass(parser, []);
    expect(results).toHaveLength(0);
  });
});

// ─── Heritage edge emission (Wave 21 Phase 1) ─────────────────────────────────
//
// Tests the definitionPass happy path (heritage edge resolves via symbolsByName)
// and the skip path (unresolved external interface — Decision 4).
// Uses synthetic IndexedFile fixtures; no real tree-sitter WASM needed.

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const HERITAGE_PROJECT = 'heritage-unit';

function makeHeritageDef(
  name: string,
  kind: ExtractedDefinition['kind'],
  opts: { extendsClause?: string | null; implements?: string[] } = {},
): ExtractedDefinition {
  return {
    name,
    kind,
    signature: null,
    returnType: null,
    startLine: 1,
    endLine: 10,
    isExported: true,
    isDefault: false,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    decorators: [],
    receiver: null,
    constants: [],
    extendsClause: opts.extendsClause ?? (kind === 'Class' ? null : undefined),
    implements: opts.implements,
  };
}

function makeHeritageFile(relativePath: string, defs: ExtractedDefinition[]): IndexedFile {
  return {
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    extension: 'ts',
    sizeBytes: 100,
    mtimeMs: Date.now(),
    contentHash: 'abc123',
    parsed: {
      filePath: relativePath,
      language: 'typescript',
      lineCount: 20,
      definitions: defs,
      imports: [],
      calls: [],
      routes: [],
      exportedNames: defs.map((d) => d.name),
      hasParseError: false,
      firstErrorLine: null,
    },
  };
}

function setupHeritageDb(): GraphDatabase {
  const db = new GraphDatabase(':memory:');
  db.upsertProject({
    name: HERITAGE_PROJECT,
    root_path: '/repo',
    indexed_at: Date.now(),
    node_count: 0,
    edge_count: 0,
  });
  db.insertNode({
    id: HERITAGE_PROJECT,
    project: HERITAGE_PROJECT,
    label: 'Project',
    name: HERITAGE_PROJECT,
    qualified_name: HERITAGE_PROJECT,
    file_path: null,
    start_line: null,
    end_line: null,
    props: { name: HERITAGE_PROJECT, root_path: '/repo' },
  });
  return db;
}

function insertFileNode(db: GraphDatabase, relativePath: string): string {
  const fileQn = `${HERITAGE_PROJECT}.${relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
  db.insertNode({
    id: fileQn,
    project: HERITAGE_PROJECT,
    label: 'File',
    name: relativePath,
    qualified_name: fileQn,
    file_path: relativePath,
    start_line: null,
    end_line: null,
    props: {},
  });
  return fileQn;
}

describe('definitionPass — Wave 21 heritage edge emission', () => {
  let db: GraphDatabase;

  beforeEach(() => { db = setupHeritageDb(); });
  afterEach(() => { db.close(); });

  it('emits EXTENDS edge when target class resolves in symbolsByName', () => {
    const filePath = 'src/foo.ts';
    insertFileNode(db, filePath);
    const files = [makeHeritageFile(filePath, [
      makeHeritageDef('Base', 'Class'),
      makeHeritageDef('Child', 'Class', { extendsClause: 'Base' }),
    ])];

    definitionPass(db, HERITAGE_PROJECT, files);

    const fileQn = `${HERITAGE_PROJECT}.src.foo`;
    const childQn = `${fileQn}.Child`;
    const extendsEdges = db.getOutboundEdges(childQn, 'EXTENDS');
    expect(extendsEdges).toHaveLength(1);
    expect(extendsEdges[0].target_id).toBe(`${fileQn}.Base`);
  });

  it('emits IMPLEMENTS edge when target interface resolves in symbolsByName', () => {
    const filePath = 'src/bar.ts';
    insertFileNode(db, filePath);
    const files = [makeHeritageFile(filePath, [
      makeHeritageDef('IA', 'Interface'),
      makeHeritageDef('Impl', 'Class', { implements: ['IA'] }),
    ])];

    definitionPass(db, HERITAGE_PROJECT, files);

    const fileQn = `${HERITAGE_PROJECT}.src.bar`;
    const implQn = `${fileQn}.Impl`;
    const implementsEdges = db.getOutboundEdges(implQn, 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0].target_id).toBe(`${fileQn}.IA`);
  });

  it('skips IMPLEMENTS edge when target interface is external (unresolved in symbolsByName)', () => {
    const filePath = 'src/baz.ts';
    insertFileNode(db, filePath);
    const files = [makeHeritageFile(filePath, [
      makeHeritageDef('WithExternal', 'Class', { implements: ['UnknownExternal'] }),
    ])];

    definitionPass(db, HERITAGE_PROJECT, files);

    const fileQn = `${HERITAGE_PROJECT}.src.baz`;
    const classQn = `${fileQn}.WithExternal`;
    const implementsEdges = db.getOutboundEdges(classQn, 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(0);
  });

  it('emits both EXTENDS and multiple IMPLEMENTS edges for a class with full heritage', () => {
    const filePath = 'src/full.ts';
    insertFileNode(db, filePath);
    const files = [makeHeritageFile(filePath, [
      makeHeritageDef('Base', 'Class'),
      makeHeritageDef('IA', 'Interface'),
      makeHeritageDef('IB', 'Interface'),
      makeHeritageDef('Full', 'Class', { extendsClause: 'Base', implements: ['IA', 'IB'] }),
    ])];

    definitionPass(db, HERITAGE_PROJECT, files);

    const fileQn = `${HERITAGE_PROJECT}.src.full`;
    const fullQn = `${fileQn}.Full`;
    const extendsEdges = db.getOutboundEdges(fullQn, 'EXTENDS');
    expect(extendsEdges).toHaveLength(1);
    expect(extendsEdges[0].target_id).toBe(`${fileQn}.Base`);

    const implementsEdges = db.getOutboundEdges(fullQn, 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(2);
    const targets = implementsEdges.map((e) => e.target_id).sort();
    expect(targets).toEqual([`${fileQn}.IA`, `${fileQn}.IB`].sort());
  });

  it('plain class with no heritage emits zero EXTENDS and IMPLEMENTS edges', () => {
    const filePath = 'src/plain.ts';
    insertFileNode(db, filePath);
    const files = [makeHeritageFile(filePath, [
      makeHeritageDef('Plain', 'Class'),
    ])];

    definitionPass(db, HERITAGE_PROJECT, files);

    const fileQn = `${HERITAGE_PROJECT}.src.plain`;
    const plainQn = `${fileQn}.Plain`;
    expect(db.getOutboundEdges(plainQn, 'EXTENDS')).toHaveLength(0);
    expect(db.getOutboundEdges(plainQn, 'IMPLEMENTS')).toHaveLength(0);
  });
});

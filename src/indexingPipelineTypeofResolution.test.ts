/**
 * indexingPipelineTypeofResolution.test.ts — Unit tests for Pass 5.5: typeof resolution.
 *
 * Tests the source-text scanning approach for the 6 typeof patterns from ADR D3.
 * The pass reads TypeScript source text from indexed files, scans for typeof patterns,
 * and emits TYPEOF_REFERENCES edges to the graph.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Import the exported types and functions under test
import { typeofResolutionPass } from './indexingPipelineTypeofResolution';
import type { TypeofPattern } from './indexingPipelineTypeofResolution';

// ─── Internal function testing via white-box access ───────────────────────────
// We test the scanning logic by calling typeofResolutionPass with mock DB and
// synthetic IndexedFile objects. The source text is read from absolutePath.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IndexedFile } from './indexingPipelineTypes';
import type { GraphDatabase } from './graphDatabase';
import type { GraphEdge, GraphNode } from './graphDatabaseTypes';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeIndexedFile(
  relativePath: string,
  absolutePath: string,
  extension: string,
): IndexedFile {
  return {
    relativePath,
    absolutePath,
    extension,
    sizeBytes: 0,
    mtimeMs: 0,
    contentHash: 'abc123',
    parsed: {
      filePath: relativePath,
      language: extension === 'ts' || extension === 'tsx' ? 'typescript' : 'javascript',
      lineCount: 10,
      definitions: [],
      imports: [],
      calls: [],
      routes: [],
      exportedNames: [],
    },
  };
}

type InsertedEdge = Omit<GraphEdge, 'id'>;

function makeMockDb(
  symbolsByName: Map<string, string[]>,
  insertedEdges: InsertedEdge[],
): GraphDatabase {
  const allNodes: GraphNode[] = [];
  for (const [name, ids] of symbolsByName) {
    for (const id of ids) {
      allNodes.push({
        id,
        project: 'test',
        label: 'Function',
        name,
        qualified_name: id,
        file_path: null,
        start_line: null,
        end_line: null,
        props: {},
      });
    }
  }

  return {
    getNodesByLabel: (_project: string, _label: string) => allNodes,
    insertEdges: (edges: InsertedEdge[]) => {
      for (const e of edges) insertedEdges.push(e);
    },
    transaction: (fn: () => void) => fn(),
  } as unknown as GraphDatabase;
}

function writeTmpFile(dir: string, filename: string, content: string): string {
  const p = path.join(dir, filename);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('typeofResolutionPass — Pass 5.5', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typeof-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits TYPEOF_REFERENCES edge for plain `typeof X`', () => {
    const source = `
type MyType = typeof useConfig;
`;
    const absPath = writeTmpFile(tmpDir, 'consumer.ts', source);
    const symbolsByName = new Map([['useConfig', ['test.useConfig']]]);
    const insertedEdges: InsertedEdge[] = [];
    const db = makeMockDb(symbolsByName, insertedEdges);

    const file = makeIndexedFile('consumer.ts', absPath, 'ts');
    typeofResolutionPass(db, 'test', tmpDir, [file]);

    expect(insertedEdges).toHaveLength(1);
    expect(insertedEdges[0].type).toBe('TYPEOF_REFERENCES');
    expect(insertedEdges[0].target_id).toBe('test.useConfig');
    const props = insertedEdges[0].props as Record<string, unknown>;
    // Single pattern file: patterns array contains 'typeof'
    expect(Array.isArray(props.patterns)).toBe(true);
    expect((props.patterns as string[])).toContain('typeof' as TypeofPattern);
    expect(props.line).toBe(2); // Second line (1-based)
    expect(props.resolution_method).toBe('typeof_regex');
  });

  it('emits TYPEOF_REFERENCES edge for `ReturnType<typeof X>`', () => {
    const source = `
type ConfigType = ReturnType<typeof useConfig>;
`;
    const absPath = writeTmpFile(tmpDir, 'consumer.ts', source);
    const symbolsByName = new Map([['useConfig', ['test.useConfig']]]);
    const insertedEdges: InsertedEdge[] = [];
    const db = makeMockDb(symbolsByName, insertedEdges);

    const file = makeIndexedFile('consumer.ts', absPath, 'ts');
    typeofResolutionPass(db, 'test', tmpDir, [file]);

    expect(insertedEdges).toHaveLength(1);
    expect(insertedEdges[0].type).toBe('TYPEOF_REFERENCES');
    expect(insertedEdges[0].target_id).toBe('test.useConfig');
    const props = insertedEdges[0].props as Record<string, unknown>;
    // ReturnType<typeof useConfig> should include the ReturnType<typeof> pattern
    expect(Array.isArray(props.patterns)).toBe(true);
    expect((props.patterns as string[])).toContain('ReturnType<typeof>' as TypeofPattern);
  });

  it('handles all 6 typeof patterns in a single file — merged into one edge per source+target', () => {
    const source = [
      'type A = typeof myFn;',
      'type B = ReturnType<typeof myFn>;',
      'type C = Parameters<typeof myFn>;',
      'type D = InstanceType<typeof myFn>;',
      'type E = Awaited<ReturnType<typeof myFn>>;',
      'type F = keyof typeof myFn;',
    ].join('\n');

    const absPath = writeTmpFile(tmpDir, 'all-patterns.ts', source);
    const symbolsByName = new Map([['myFn', ['test.myFn']]]);
    const insertedEdges: InsertedEdge[] = [];
    const db = makeMockDb(symbolsByName, insertedEdges);

    const file = makeIndexedFile('all-patterns.ts', absPath, 'ts');
    typeofResolutionPass(db, 'test', tmpDir, [file]);

    // All 6 patterns for the same source+target are merged into one edge
    // (DB has UNIQUE(source_id, target_id, type) constraint).
    expect(insertedEdges).toHaveLength(1);
    expect(insertedEdges[0].type).toBe('TYPEOF_REFERENCES');
    expect(insertedEdges[0].target_id).toBe('test.myFn');

    const props = insertedEdges[0].props as Record<string, unknown>;
    const patternsArr = props.patterns as string[];
    expect(Array.isArray(patternsArr)).toBe(true);

    // All 6 patterns should be captured in the merged patterns array
    const expectedPatterns: TypeofPattern[] = [
      'typeof',
      'ReturnType<typeof>',
      'Parameters<typeof>',
      'InstanceType<typeof>',
      'Awaited<ReturnType<typeof>>',
      'keyof typeof',
    ];
    for (const expected of expectedPatterns) {
      expect(
        patternsArr,
        `Expected pattern '${expected}' in merged patterns but got: ${JSON.stringify(patternsArr)}`,
      ).toContain(expected);
    }
  });

  it('skips JS and JSX files — typeof in value position is not a type reference', () => {
    const source = `
// In JS, typeof is a value-level operator, not a type annotation
const t = typeof someFunction;
`;
    const absPath = writeTmpFile(tmpDir, 'consumer.js', source);
    const symbolsByName = new Map([['someFunction', ['test.someFunction']]]);
    const insertedEdges: InsertedEdge[] = [];
    const db = makeMockDb(symbolsByName, insertedEdges);

    const jsFile = makeIndexedFile('consumer.js', absPath, 'js');
    typeofResolutionPass(db, 'test', tmpDir, [jsFile]);

    // No edges should be emitted for JS files
    expect(insertedEdges).toHaveLength(0);
  });

  it('skips typeof references to symbols not in the graph (unresolved targets)', () => {
    const source = `
type T = ReturnType<typeof externalLibFunction>;
`;
    const absPath = writeTmpFile(tmpDir, 'consumer.ts', source);
    // symbolsByName does NOT contain 'externalLibFunction' — it's external
    const symbolsByName = new Map<string, string[]>();
    const insertedEdges: InsertedEdge[] = [];
    const db = makeMockDb(symbolsByName, insertedEdges);

    const file = makeIndexedFile('consumer.ts', absPath, 'ts');
    typeofResolutionPass(db, 'test', tmpDir, [file]);

    // Unresolved symbols are skipped — no edge emitted
    expect(insertedEdges).toHaveLength(0);
  });

  it('deduplicates multiple occurrences of the same source+target — yields exactly one edge', () => {
    const source = [
      'type A = typeof useConfig;',
      'type B = typeof useConfig;', // Same pattern, same target — second occurrence
    ].join('\n');

    const absPath = writeTmpFile(tmpDir, 'consumer.ts', source);
    const symbolsByName = new Map([['useConfig', ['test.useConfig']]]);
    const insertedEdges: InsertedEdge[] = [];
    const db = makeMockDb(symbolsByName, insertedEdges);

    const file = makeIndexedFile('consumer.ts', absPath, 'ts');
    typeofResolutionPass(db, 'test', tmpDir, [file]);

    // Repeated same pattern for same source+target should be merged into ONE edge
    // to respect the DB UNIQUE(source_id, target_id, type) constraint.
    expect(insertedEdges).toHaveLength(1);
    expect(insertedEdges[0].type).toBe('TYPEOF_REFERENCES');
    const props = insertedEdges[0].props as Record<string, unknown>;
    // The 'typeof' pattern appears once in the merged patterns list (no duplicates)
    const patternsArr = props.patterns as string[];
    expect(patternsArr.filter((p) => p === 'typeof')).toHaveLength(1);
  });
});

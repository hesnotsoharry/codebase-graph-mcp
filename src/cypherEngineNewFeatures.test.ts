/**
 * cypherEngineNewFeatures.test.ts — Unit + integration coverage for Wave-77 helpers.
 *
 * buildOptionalHopJoin: unit-tested directly (pure SQL string builder).
 * buildUnwindSql / multi-pattern MATCH: integration-tested via CypherEngine.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CypherEngine } from './cypherEngine';
import { buildOptionalHopJoin, parseMultiPattern } from './cypherEngineNewFeatures';
import type { MatchPattern } from './cypherEngineSupport';
import { GraphDatabase } from './graphDatabase';

// ─── buildOptionalHopJoin unit tests ─────────────────────────────────────────

describe('buildOptionalHopJoin', () => {
  it('returns empty string for non-hop pattern', () => {
    const single: MatchPattern = { kind: 'single', alias: 'n', label: 'Function' };
    expect(buildOptionalHopJoin(single, 'n')).toBe('');
  });

  it('builds outbound LEFT JOIN fragment', () => {
    const hop: MatchPattern = {
      kind: 'hop',
      left: { alias: 'a', label: null },
      right: { alias: 'b', label: null },
      edgeAlias: null,
      edgeType: 'CALLS',
      direction: 'outbound',
    };
    const result = buildOptionalHopJoin(hop, 'a');
    expect(result).toContain('LEFT JOIN edges e_opt ON e_opt.source_id = a.id');
    expect(result).toContain("AND e_opt.type = 'CALLS'");
    expect(result).toContain('LEFT JOIN nodes b ON b.id = e_opt.target_id');
  });

  it('builds inbound LEFT JOIN fragment', () => {
    const hop: MatchPattern = {
      kind: 'hop',
      left: { alias: 'a', label: null },
      right: { alias: 'b', label: null },
      edgeAlias: null,
      edgeType: null,
      direction: 'inbound',
    };
    const result = buildOptionalHopJoin(hop, 'a');
    expect(result).toContain('LEFT JOIN edges e_opt ON e_opt.target_id = a.id');
    expect(result).toContain('LEFT JOIN nodes b ON b.id = e_opt.source_id');
    expect(result).not.toContain('type =');
  });

  it('omits edge type condition when edgeType is null', () => {
    const hop: MatchPattern = {
      kind: 'hop',
      left: { alias: 'n', label: null },
      right: { alias: 'm', label: null },
      edgeAlias: null,
      edgeType: null,
      direction: 'outbound',
    };
    expect(buildOptionalHopJoin(hop, 'n')).not.toContain('type');
  });
});

// ─── UNWIND + OPTIONAL MATCH integration via CypherEngine ────────────────────

const PROJECT = 'new-features-test';

function seed(db: GraphDatabase): void {
  db.upsertProject({
    name: PROJECT,
    root_path: '/tmp',
    indexed_at: 1700000000000,
    node_count: 5,
    edge_count: 3,
  });
  db.insertNodes([
    {
      id: 'fn1',
      project: PROJECT,
      label: 'Function',
      name: 'alpha',
      qualified_name: `${PROJECT}.alpha`,
      file_path: 'a.ts',
      start_line: 1,
      end_line: 5,
      props: {},
    },
    {
      id: 'fn2',
      project: PROJECT,
      label: 'Function',
      name: 'beta',
      qualified_name: `${PROJECT}.beta`,
      file_path: 'a.ts',
      start_line: 6,
      end_line: 10,
      props: {},
    },
    {
      id: 'fn3',
      project: PROJECT,
      label: 'Function',
      name: 'gamma',
      qualified_name: `${PROJECT}.gamma`,
      file_path: 'b.ts',
      start_line: 1,
      end_line: 5,
      props: {},
    },
    {
      id: 'cls1',
      project: PROJECT,
      label: 'Class',
      name: 'Widget',
      qualified_name: `${PROJECT}.Widget`,
      file_path: 'c.ts',
      start_line: 1,
      end_line: 20,
      props: {},
    },
    {
      id: 'cls2',
      project: PROJECT,
      label: 'Class',
      name: 'Gadget',
      qualified_name: `${PROJECT}.Gadget`,
      file_path: 'c.ts',
      start_line: 21,
      end_line: 40,
      props: {},
    },
  ]);
  db.insertEdges([
    { project: PROJECT, source_id: 'fn1', target_id: 'cls1', type: 'CALLS', props: {} },
    { project: PROJECT, source_id: 'fn2', target_id: 'cls1', type: 'CALLS', props: {} },
    // fn3 has no outbound CALLS edge — used for OPTIONAL MATCH null test
  ]);
}

describe('CypherEngine — UNWIND', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seed(db);
    engine = new CypherEngine(db, PROJECT);
  });
  afterEach(() => db.close());

  it('UNWIND literal list returns matching nodes', () => {
    const result = engine.execute("UNWIND ['alpha', 'beta'] AS name MATCH (n) RETURN n.name");
    expect(result.rows.length).toBe(2);
    const names = result.rows.map((r) => r.n_name);
    expect(new Set(names)).toEqual(new Set(['alpha', 'beta']));
  });

  it('UNWIND with label filter returns only matching label', () => {
    const result = engine.execute(
      "UNWIND ['alpha', 'Widget'] AS name MATCH (n:Function) RETURN n.name",
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].n_name).toBe('alpha');
  });

  it('UNWIND with no matches returns empty rows', () => {
    const result = engine.execute("UNWIND ['nonexistent'] AS name MATCH (n) RETURN n.name");
    expect(result.rows.length).toBe(0);
  });

  it('UNWIND empty list returns empty rows', () => {
    const result = engine.execute('UNWIND [] AS name MATCH (n) RETURN n.name');
    expect(result.rows.length).toBe(0);
  });

  it('UNWIND with numeric values matches start_line', () => {
    // fn1 (start_line:1) + fn2 (start_line:6) + fn3 (start_line:1) — fn1 and fn3 both have start_line=1
    const result = engine.execute('UNWIND [1, 6] AS start_line MATCH (n:Function) RETURN n.name');
    expect(result.rows.length).toBe(3);
    const names = result.rows.map((r) => r.n_name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toContain('gamma');
  });

  it('UNWIND invalid syntax throws descriptive error', () => {
    expect(() => engine.execute("UNWIND 'alpha' AS name MATCH (n) RETURN n.name")).toThrow(
      /Unsupported UNWIND syntax/,
    );
  });
});

describe('CypherEngine — OPTIONAL MATCH', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seed(db);
    engine = new CypherEngine(db, PROJECT);
  });
  afterEach(() => db.close());

  it('OPTIONAL MATCH includes rows with no right-side match (nulls)', () => {
    const result = engine.execute(
      'MATCH (n:Function) OPTIONAL MATCH (n)-[:CALLS]->(c) RETURN n.name, c.name',
    );
    // fn1 and fn2 have CALLS edges; fn3 does not
    expect(result.rows.length).toBe(3);
    const fn3Row = result.rows.find((r) => r.n_name === 'gamma');
    expect(fn3Row).toBeDefined();
    expect(fn3Row!.c_name).toBeNull();
  });

  it('OPTIONAL MATCH rows with matches have non-null right side', () => {
    const result = engine.execute(
      'MATCH (n:Function) OPTIONAL MATCH (n)-[:CALLS]->(c) RETURN n.name, c.name',
    );
    const fn1Row = result.rows.find((r) => r.n_name === 'alpha');
    expect(fn1Row).toBeDefined();
    expect(fn1Row!.c_name).toBe('Widget');
  });

  it('WITH error still fires before OPTIONAL MATCH is attempted', () => {
    expect(() => engine.execute('WITH 1 AS x MATCH (n) RETURN n.name')).toThrow(
      /Cypher feature not supported.*WITH/,
    );
  });
});

// ─── parseMultiPattern unit tests ────────────────────────────────────────────

describe('parseMultiPattern', () => {
  it('returns null for a single-pattern string', () => {
    expect(parseMultiPattern('(a)-[:CALLS]->(b)')).toBeNull();
  });

  it('parses two-hop chain into two HopPatterns', () => {
    const result = parseMultiPattern('(a)-[:CALLS]->(b), (b)-[:DEFINES]->(c)');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].kind).toBe('hop');
    expect(result![0].left.alias).toBe('a');
    expect(result![0].right.alias).toBe('b');
    expect(result![0].edgeType).toBe('CALLS');
    expect(result![1].left.alias).toBe('b');
    expect(result![1].right.alias).toBe('c');
    expect(result![1].edgeType).toBe('DEFINES');
  });

  it('throws when a sub-pattern is not a hop', () => {
    expect(() => parseMultiPattern('(a), (b)-[:X]->(c)')).toThrow(/must be a hop/);
  });
});

// ─── Multi-pattern MATCH integration ─────────────────────────────────────────

const MULTI_PROJECT = 'multi-pattern-test';

function seedMulti(db: GraphDatabase): void {
  db.upsertProject({
    name: MULTI_PROJECT,
    root_path: '/tmp',
    indexed_at: 1000,
    node_count: 3,
    edge_count: 2,
  });
  db.insertNodes([
    {
      id: 'ma',
      project: MULTI_PROJECT,
      label: 'Function',
      name: 'caller',
      qualified_name: `${MULTI_PROJECT}.caller`,
      file_path: 'a.ts',
      start_line: 1,
      end_line: 5,
      props: {},
    },
    {
      id: 'mb',
      project: MULTI_PROJECT,
      label: 'Class',
      name: 'Svc',
      qualified_name: `${MULTI_PROJECT}.Svc`,
      file_path: 'b.ts',
      start_line: 1,
      end_line: 10,
      props: {},
    },
    {
      id: 'mc',
      project: MULTI_PROJECT,
      label: 'Function',
      name: 'handler',
      qualified_name: `${MULTI_PROJECT}.handler`,
      file_path: 'c.ts',
      start_line: 1,
      end_line: 5,
      props: {},
    },
  ]);
  db.insertEdges([
    { project: MULTI_PROJECT, source_id: 'ma', target_id: 'mb', type: 'CALLS', props: {} },
    { project: MULTI_PROJECT, source_id: 'mb', target_id: 'mc', type: 'DEFINES', props: {} },
  ]);
}

describe('CypherEngine — multi-pattern MATCH', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seedMulti(db);
    engine = new CypherEngine(db, MULTI_PROJECT);
  });
  afterEach(() => db.close());

  it('two-hop chain returns the linked triple', () => {
    const r = engine.execute(
      'MATCH (a)-[:CALLS]->(b), (b)-[:DEFINES]->(c) RETURN a.name, b.name, c.name',
    );
    expect(r.total).toBe(1);
    expect(r.rows[0].a_name).toBe('caller');
    expect(r.rows[0].b_name).toBe('Svc');
    expect(r.rows[0].c_name).toBe('handler');
  });

  it('returns empty when chain is broken', () => {
    const r = engine.execute('MATCH (a)-[:CALLS]->(b), (b)-[:CALLS]->(c) RETURN a.name, c.name');
    expect(r.total).toBe(0);
  });

  it('label filters narrow results correctly', () => {
    const r = engine.execute(
      'MATCH (a:Function)-[:CALLS]->(b:Class), (b)-[:DEFINES]->(c:Function) RETURN c.name',
    );
    expect(r.total).toBe(1);
    expect(r.rows[0].c_name).toBe('handler');
  });
});

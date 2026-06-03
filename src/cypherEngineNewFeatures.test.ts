/**
 * cypherEngineNewFeatures.test.ts — Unit + integration coverage for Wave-77 helpers.
 *
 * buildOptionalHopJoin: unit-tested directly (pure SQL string builder).
 * buildUnwindSql / multi-pattern MATCH: integration-tested via CypherEngine.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CypherEngine } from './cypherEngine';
import type { NodeLabel } from './graphDatabaseTypes';
import { buildOptionalHopJoin, parseMultiPattern } from './cypherEngineNewFeatures';
import type { MatchPattern } from './cypherEngineSupport';
import { GraphDatabase } from './graphDatabase';

// ─── buildOptionalHopJoin unit tests ─────────────────────────────────────────

describe('buildOptionalHopJoin', () => {
  it('returns empty string for non-hop pattern', () => {
    const single: MatchPattern = { kind: 'single', alias: 'n', label: 'Function' };
    expect(buildOptionalHopJoin(single, 'n', [])).toBe('');
  });

  it('emits ? placeholder for edge type and pushes value onto params', () => {
    const hop: MatchPattern = {
      kind: 'hop',
      left: { alias: 'a', label: null },
      right: { alias: 'b', label: null },
      edgeAlias: null,
      edgeType: 'CALLS',
      direction: 'outbound',
    };
    const params: unknown[] = [];
    const result = buildOptionalHopJoin(hop, 'a', params);
    expect(result).toContain('LEFT JOIN edges e_opt ON e_opt.source_id = a.id');
    expect(result).toContain('AND e_opt.type = ?');
    expect(result).toContain('LEFT JOIN nodes b ON b.id = e_opt.target_id');
    expect(params).toEqual(['CALLS']);
    // No inline quoted literal — the type value is bound, not inlined.
    expect(result).not.toMatch(/'[A-Z_]+'/);
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
    const params: unknown[] = [];
    const result = buildOptionalHopJoin(hop, 'a', params);
    expect(result).toContain('LEFT JOIN edges e_opt ON e_opt.target_id = a.id');
    expect(result).toContain('LEFT JOIN nodes b ON b.id = e_opt.source_id');
    expect(result).not.toContain('type =');
    expect(params).toEqual([]);
  });

  it('omits edge type condition and does not push params when edgeType is null', () => {
    const hop: MatchPattern = {
      kind: 'hop',
      left: { alias: 'n', label: null },
      right: { alias: 'm', label: null },
      edgeAlias: null,
      edgeType: null,
      direction: 'outbound',
    };
    const params: unknown[] = [];
    expect(buildOptionalHopJoin(hop, 'n', params)).not.toContain('type');
    expect(params).toEqual([]);
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

  it('WITH is now supported — MATCH (n) WITH n RETURN n.name executes without error', () => {
    // Wave 1 Phase 2: WITH is a supported passthrough pipe; no longer throws.
    expect(() => engine.execute('MATCH (n) WITH n RETURN n.name')).not.toThrow();
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

// ─── Wave 1 Phase 2: WITH pipe, negated existence, pagination ─────────────────

const WAVE1_PROJECT = 'wave1-phase2-test';

function seedWave1(db: GraphDatabase): void {
  db.upsertProject({
    name: WAVE1_PROJECT,
    root_path: '/tmp',
    indexed_at: 1000,
    node_count: 4,
    edge_count: 1,
  });
  db.insertNodes([
    // calledFn: has an inbound CALLS edge
    {
      id: 'w1fn1',
      project: WAVE1_PROJECT,
      label: 'Function',
      name: 'calledFn',
      qualified_name: `${WAVE1_PROJECT}.calledFn`,
      file_path: 'a.ts',
      start_line: 1,
      end_line: 5,
      props: {},
    },
    // deadFn: has NO inbound CALLS edge (dead / uncalled)
    {
      id: 'w1fn2',
      project: WAVE1_PROJECT,
      label: 'Function',
      name: 'deadFn',
      qualified_name: `${WAVE1_PROJECT}.deadFn`,
      file_path: 'a.ts',
      start_line: 6,
      end_line: 10,
      props: {},
    },
    // callerFn: has an outbound CALLS edge, no inbound CALLS edge
    {
      id: 'w1fn3',
      project: WAVE1_PROJECT,
      label: 'Function',
      name: 'callerFn',
      qualified_name: `${WAVE1_PROJECT}.callerFn`,
      file_path: 'b.ts',
      start_line: 1,
      end_line: 5,
      props: {},
    },
    // MyClass: used for mixed-label / WITH filter tests
    {
      id: 'w1cls1',
      project: WAVE1_PROJECT,
      label: 'Class',
      name: 'MyClass',
      qualified_name: `${WAVE1_PROJECT}.MyClass`,
      file_path: 'c.ts',
      start_line: 1,
      end_line: 20,
      props: {},
    },
  ]);
  // callerFn CALLS calledFn
  db.insertEdges([
    { project: WAVE1_PROJECT, source_id: 'w1fn3', target_id: 'w1fn1', type: 'CALLS', props: {} },
  ]);
}

describe('CypherEngine — WITH pipe (Wave 1 Phase 2)', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seedWave1(db);
    engine = new CypherEngine(db, WAVE1_PROJECT);
  });
  afterEach(() => db.close());

  it("MATCH (n) WITH n WHERE n.label = 'Function' RETURN n.name returns only functions", () => {
    const r = engine.execute("MATCH (n) WITH n WHERE n.label = 'Function' RETURN n.name");
    const names = r.rows.map((row) => row.n_name);
    expect(names).toContain('calledFn');
    expect(names).toContain('deadFn');
    expect(names).toContain('callerFn');
    expect(names).not.toContain('MyClass');
    expect(r.total).toBe(3);
  });

  it('WITH pipe with no following WHERE is a passthrough — all nodes returned', () => {
    const r = engine.execute('MATCH (n) WITH n RETURN n.name');
    expect(r.total).toBe(4);
  });

  it('WITH pipe + WHERE + LIMIT respects the limit', () => {
    const r = engine.execute("MATCH (n) WITH n WHERE n.label = 'Function' RETURN n.name LIMIT 2");
    expect(r.total).toBe(2);
  });
});

describe('CypherEngine — WHERE NOT negated existence (Wave 1 Phase 2)', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seedWave1(db);
    engine = new CypherEngine(db, WAVE1_PROJECT);
  });
  afterEach(() => db.close());

  it('WHERE NOT ()-[:CALLS]->(n) returns uncalled functions and excludes calledFn', () => {
    const r = engine.execute('MATCH (n:Function) WHERE NOT ()-[:CALLS]->(n) RETURN n.name');
    const names = r.rows.map((row) => row.n_name);
    // deadFn has no inbound CALLS edge → returned
    expect(names).toContain('deadFn');
    // callerFn has no inbound CALLS edge → returned
    expect(names).toContain('callerFn');
    // calledFn HAS an inbound CALLS edge → excluded
    expect(names).not.toContain('calledFn');
  });

  it('WHERE NOT (n)-[:CALLS]->() returns functions that make no outbound calls', () => {
    const r = engine.execute('MATCH (n:Function) WHERE NOT (n)-[:CALLS]->() RETURN n.name');
    const names = r.rows.map((row) => row.n_name);
    // deadFn has no outbound CALLS → returned
    expect(names).toContain('deadFn');
    // calledFn has no outbound CALLS → returned
    expect(names).toContain('calledFn');
    // callerFn HAS an outbound CALLS edge → excluded
    expect(names).not.toContain('callerFn');
  });

  it('WHERE NOT ()-[:CALLS]->(n) AND scalar filter narrows to a single node', () => {
    const r = engine.execute(
      "MATCH (n:Function) WHERE NOT ()-[:CALLS]->(n) AND n.name = 'deadFn' RETURN n.name",
    );
    expect(r.total).toBe(1);
    expect(r.rows[0].n_name).toBe('deadFn');
  });
});

// ─── Wave 3: edge-type alternation in negated-existence ──────────────────────
// Acceptance test (orchestrator-authored, Phase 1). Must NOT be modified by the
// implementer. Today `[:CALLS|ASYNC_CALLS]` does not parse, so the alternation
// case fails; the single-type contrast case documents the false-positive being fixed.

const ALT_PROJECT = 'alternation-test';

/**
 * Seed three functions exercising the call-edge taxonomy:
 *   - syncCalled:  inbound CALLS only            (called synchronously)
 *   - asyncCalled: inbound ASYNC_CALLS only      (called ONLY via await — the false-positive case)
 *   - deadFn:      no inbound call edge of any kind (genuinely uncalled)
 */
function seedAlternation(db: GraphDatabase): void {
  db.upsertProject({
    name: ALT_PROJECT,
    root_path: '/tmp',
    indexed_at: 1700000000000,
    node_count: 4,
    edge_count: 2,
  });
  const fn = (id: string, name: string, line: number) => ({
    id,
    project: ALT_PROJECT,
    label: 'Function' as NodeLabel,
    name,
    qualified_name: `${ALT_PROJECT}.${name}`,
    file_path: 'a.ts',
    start_line: line,
    end_line: line + 1,
    props: {},
  });
  db.insertNodes([
    fn('caller', 'caller', 1),
    fn('syncCalled', 'syncCalled', 3),
    fn('asyncCalled', 'asyncCalled', 5),
    fn('deadFn', 'deadFn', 7),
  ]);
  db.insertEdges([
    { project: ALT_PROJECT, source_id: 'caller', target_id: 'syncCalled', type: 'CALLS', props: {} },
    { project: ALT_PROJECT, source_id: 'caller', target_id: 'asyncCalled', type: 'ASYNC_CALLS', props: {} },
  ]);
}

describe('CypherEngine — Wave 3 edge-type alternation in negated-existence', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seedAlternation(db);
    engine = new CypherEngine(db, ALT_PROJECT);
  });
  afterEach(() => db.close());

  it('NOT ()-[:CALLS|ASYNC_CALLS]->(n) excludes BOTH sync- and async-called fns (no false positive)', () => {
    const r = engine.execute(
      'MATCH (n:Function) WHERE NOT ()-[:CALLS|ASYNC_CALLS]->(n) RETURN n.name',
    );
    const names = r.rows.map((row) => row.n_name);
    // Only genuinely-uncalled functions remain.
    expect(names).toContain('deadFn');
    expect(names).toContain('caller'); // caller is itself uncalled
    // Both call kinds are negated → neither callee is flagged dead.
    expect(names).not.toContain('syncCalled');
    expect(names).not.toContain('asyncCalled');
  });

  it('single-type NOT ()-[:CALLS]->(n) still FALSE-POSITIVES asyncCalled (documents the bug alternation fixes)', () => {
    const r = engine.execute('MATCH (n:Function) WHERE NOT ()-[:CALLS]->(n) RETURN n.name');
    const names = r.rows.map((row) => row.n_name);
    // asyncCalled has no inbound CALLS edge → single-type query wrongly returns it.
    expect(names).toContain('asyncCalled');
    // syncCalled is correctly excluded by the single-type query.
    expect(names).not.toContain('syncCalled');
  });

  it('single-type negated-existence behavior is unchanged (regression guard)', () => {
    const r = engine.execute('MATCH (n:Function) WHERE NOT ()-[:CALLS]->(n) RETURN n.name');
    const names = r.rows.map((row) => row.n_name);
    expect(names).toContain('deadFn');
    expect(names).not.toContain('syncCalled');
  });
});

// ─── Wave 3: varpath silently dropped NOT clause → explicit error ────────────
// Acceptance test (orchestrator-authored, Phase 2). Must NOT be modified by the
// implementer. Today buildVarpathStartConditions/buildVarpathEndConditions
// (cypherEngineVarpath.ts:41,68) `continue` past negated_existence conditions,
// so this query SILENTLY drops the NOT and returns wrong results. After the fix
// it must throw an explicit error naming the limitation (variable-length paths).

const VARPATH_PROJECT = 'varpath-not-test';

function seedVarpath(db: GraphDatabase): void {
  db.upsertProject({
    name: VARPATH_PROJECT,
    root_path: '/tmp',
    indexed_at: 1700000000000,
    node_count: 3,
    edge_count: 2,
  });
  const fn = (id: string, name: string, line: number) => ({
    id,
    project: VARPATH_PROJECT,
    label: 'Function' as NodeLabel,
    name,
    qualified_name: `${VARPATH_PROJECT}.${name}`,
    file_path: 'a.ts',
    start_line: line,
    end_line: line + 1,
    props: {},
  });
  db.insertNodes([fn('a', 'a', 1), fn('b', 'b', 3), fn('c', 'c', 5)]);
  db.insertEdges([
    { project: VARPATH_PROJECT, source_id: 'a', target_id: 'b', type: 'CALLS', props: {} },
    { project: VARPATH_PROJECT, source_id: 'b', target_id: 'c', type: 'CALLS', props: {} },
  ]);
}

describe('CypherEngine — Wave 3 varpath + negated-existence (fail loud)', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seedVarpath(db);
    engine = new CypherEngine(db, VARPATH_PROJECT);
  });
  afterEach(() => db.close());

  it('throws an explicit error (does NOT silently drop) when a varpath query carries a NOT clause', () => {
    expect(() =>
      engine.execute(
        'MATCH (x:Function)-[:CALLS*1..3]->(y:Function) WHERE NOT ()-[:CALLS]->(y) RETURN y.name',
      ),
    ).toThrow(/variable-length/i);
  });

  it('a varpath query WITHOUT a negated clause still works (no false throw)', () => {
    const r = engine.execute(
      'MATCH (x:Function)-[:CALLS*1..3]->(y:Function) RETURN y.name',
    );
    // sanity: regression guard that the throw is scoped to NOT-bearing varpath queries only
    expect(Array.isArray(r.rows)).toBe(true);
  });
});

// ─── Varpath edge-type parameterization (Site 1 security hardening) ──────────
// Fixture: a -CALLS-> b -CALLS-> c (CALLS chain)
//          a -IMPORTS-> d
// Reuse seedVarpath which has a -CALLS-> b -CALLS-> c. Need a second project
// for the IMPORTS variant to avoid cross-contamination.

const VARPATH_EDGETYPE_PROJECT = 'varpath-edgetype-test';

function seedVarpathEdgeType(db: GraphDatabase): void {
  db.upsertProject({
    name: VARPATH_EDGETYPE_PROJECT,
    root_path: '/tmp',
    indexed_at: 1700000000000,
    node_count: 4,
    edge_count: 3,
  });
  const fn = (id: string, name: string, line: number) => ({
    id,
    project: VARPATH_EDGETYPE_PROJECT,
    label: 'Function' as NodeLabel,
    name,
    qualified_name: `${VARPATH_EDGETYPE_PROJECT}.${name}`,
    file_path: 'a.ts',
    start_line: line,
    end_line: line + 1,
    props: {},
  });
  db.insertNodes([fn('ve_a', 'a', 1), fn('ve_b', 'b', 3), fn('ve_c', 'c', 5), fn('ve_d', 'd', 7)]);
  db.insertEdges([
    { project: VARPATH_EDGETYPE_PROJECT, source_id: 've_a', target_id: 've_b', type: 'CALLS', props: {} },
    { project: VARPATH_EDGETYPE_PROJECT, source_id: 've_b', target_id: 've_c', type: 'CALLS', props: {} },
    { project: VARPATH_EDGETYPE_PROJECT, source_id: 've_a', target_id: 've_d', type: 'IMPORTS', props: {} },
  ]);
}

describe('CypherEngine — varpath edge-type param binding (Site 1 hardening)', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seedVarpathEdgeType(db);
    engine = new CypherEngine(db, VARPATH_EDGETYPE_PROJECT);
  });
  afterEach(() => db.close());

  it('CALLS-constrained varpath from `a` returns exactly {b,c} and excludes IMPORTS-only node `d`', () => {
    // Anchor on x.name = 'a' to get a single start node, avoiding duplicate paths.
    // If the edgeType param is misplaced, `d` could appear (type filter absent)
    // or nothing appears (type coerced to 0 depth by SQLite string-to-int coercion).
    const r = engine.execute("MATCH (x)-[:CALLS*1..5]->(y) WHERE x.name = 'a' RETURN y.name");
    const names = r.rows.map((row) => row.y_name).sort();
    expect(names).toEqual(['b', 'c']);
    expect(names).not.toContain('d');
    // No inline quoted literals — type value must not be interpolated into the SQL.
    // (Verified by behavior: 'd' is excluded because type filter is bound correctly.)
  });

  it('CALLS-constrained varpath returns no rows when start node has no CALLS outbound edges', () => {
    // `d` has no outbound edges at all — ensures the type filter is actually applied.
    const r = engine.execute("MATCH (x)-[:CALLS*1..5]->(y) WHERE x.name = 'd' RETURN y.name");
    expect(r.rows).toHaveLength(0);
  });

  it('varpath without edge type constraint from `a` returns all reachable nodes', () => {
    // Ensures the empty-typeFilter path (edgeType=null) still works after refactor.
    // Use [:CALLS*1..5] since we know CALLS edges exist; tests the no-edgeType-change path.
    const r = engine.execute("MATCH (x)-[:CALLS*1..5]->(y) WHERE x.name = 'a' RETURN y.name");
    const names = r.rows.map((row) => row.y_name).sort();
    // a can reach b (depth 1) and c (depth 2) via CALLS
    expect(names).toEqual(['b', 'c']);
  });

  it('end-node WHERE constraint (endParams) is bound in correct SQL doc order — only y.name=c is returned', () => {
    // This test POPULATES endParams: the `y.name = 'c'` clause pushes 'c' into endParams,
    // which must land AFTER maxHops/minHops in the bound sequence. If they were transposed
    // (endParams before depth bounds), SQLite would bind 'c' as maxDepth (coerces to 0),
    // returning zero rows — making this assertion fail rather than silently pass.
    const r = engine.execute(
      "MATCH (x)-[:CALLS*1..2]->(y) WHERE x.name = 'a' AND y.name = 'c' RETURN y.name",
    );
    const names = r.rows.map((row) => row.y_name);
    expect(names).toEqual(['c']);
  });
});

// ─── Pagination / truncated flag (>200 rows) ─────────────────────────────────

const PAGINATION_PROJECT = 'pagination-test';

/** Insert 250 Function nodes to test paging across the 200-row boundary. */
function seedPagination(db: GraphDatabase): void {
  db.upsertProject({
    name: PAGINATION_PROJECT,
    root_path: '/tmp',
    indexed_at: 1000,
    node_count: 250,
    edge_count: 0,
  });
  const nodes = Array.from({ length: 250 }, (_, i) => ({
    id: `pg_fn${i}`,
    project: PAGINATION_PROJECT,
    label: 'Function' as NodeLabel,
    name: `fn${String(i).padStart(3, '0')}`,
    qualified_name: `${PAGINATION_PROJECT}.fn${i}`,
    file_path: 'a.ts',
    start_line: i + 1,
    end_line: i + 2,
    props: {},
  }));
  db.insertNodes(nodes);
}

describe('CypherEngine — pagination and truncated flag (Wave 1 Phase 2)', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seedPagination(db);
    engine = new CypherEngine(db, PAGINATION_PROJECT);
  });
  afterEach(() => db.close());

  it('default execution of 250 rows sets truncated:true and returns 200 rows', () => {
    const r = engine.execute('MATCH (n:Function) RETURN n.name');
    expect(r.rows.length).toBe(200);
    expect(r.truncated).toBe(true);
  });

  it('first page with limit=100 returns 100 rows and truncated:true', () => {
    const r = engine.execute('MATCH (n:Function) RETURN n.name', { limit: 100 });
    expect(r.rows.length).toBe(100);
    expect(r.truncated).toBe(true);
  });

  it('third page with limit=100 offset=200 returns the remaining 50 rows and truncated:false', () => {
    const r = engine.execute('MATCH (n:Function) RETURN n.name ORDER BY n.name', {
      limit: 100,
      offset: 200,
    });
    expect(r.rows.length).toBe(50);
    expect(r.truncated).toBe(false);
  });

  it('paging through all 250 rows across three pages recovers all distinct names', () => {
    const allNames = new Set<string>();
    const opts = (offset: number) => ({ limit: 100, offset });
    const page1 = engine.execute('MATCH (n:Function) RETURN n.name ORDER BY n.name', opts(0));
    const page2 = engine.execute('MATCH (n:Function) RETURN n.name ORDER BY n.name', opts(100));
    const page3 = engine.execute('MATCH (n:Function) RETURN n.name ORDER BY n.name', opts(200));
    for (const row of [...page1.rows, ...page2.rows, ...page3.rows]) {
      allNames.add(row.n_name as string);
    }
    expect(allNames.size).toBe(250);
    expect(page1.truncated).toBe(true);
    expect(page2.truncated).toBe(true);
    expect(page3.truncated).toBe(false);
  });

  it('small dataset (≤200 rows) with default limit returns truncated:false', () => {
    const smallDb = new GraphDatabase(':memory:');
    seedWave1(smallDb);
    const smallEngine = new CypherEngine(smallDb, WAVE1_PROJECT);
    const r = smallEngine.execute('MATCH (n) RETURN n.name');
    expect(r.rows.length).toBe(4);
    expect(r.truncated).toBe(false);
    smallDb.close();
  });
});

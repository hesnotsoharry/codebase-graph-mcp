/**
 * cypherEngineRegression.test.ts — Wave 68 regression coverage + Wave 20
 * BFS cycle-detection regression.
 *
 * Wave 68 tests — one per bug from roadmap/wave-68-diagnostic.md:
 *  Bug 1 — target-node label filter applied
 *  Bug 2 — anonymous-endpoint syntax accepted
 *  Bug 3 — relationship-property access (r.confidence dedicated column)
 *  Bug 4 — labels(n) returns the node's label string
 *  Bug 5 — MATCH (p:Project) routes to projects table
 *
 * Wave 20 test:
 *  BFS handles prefix-collision node IDs without substring confusion
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CypherEngine } from './cypherEngine';
import { GraphDatabase } from './graphDatabase';
import type { BfsOptions } from './graphDatabaseTraversal';

const PROJECT = 'cypher-test';

function seed(db: GraphDatabase): void {
  db.upsertProject({
    name: PROJECT,
    root_path: '/tmp',
    indexed_at: 1700000000000,
    node_count: 4,
    edge_count: 3,
  });
  db.insertNodes([
    {
      id: 'fn1',
      project: PROJECT,
      label: 'Function',
      name: 'caller1',
      qualified_name: 'p.caller1',
      file_path: 'a.ts',
      start_line: 1,
      end_line: 5,
      props: {},
    },
    {
      id: 'fn2',
      project: PROJECT,
      label: 'Function',
      name: 'caller2',
      qualified_name: 'p.caller2',
      file_path: 'a.ts',
      start_line: 7,
      end_line: 10,
      props: {},
    },
    {
      id: 'cls1',
      project: PROJECT,
      label: 'Class',
      name: 'Foo',
      qualified_name: 'p.Foo',
      file_path: 'b.ts',
      start_line: 1,
      end_line: 20,
      props: {},
    },
    {
      id: 'fn3',
      project: PROJECT,
      label: 'Function',
      name: 'helper',
      qualified_name: 'p.helper',
      file_path: 'c.ts',
      start_line: 1,
      end_line: 3,
      props: {},
    },
  ]);
  db.insertEdges([
    { project: PROJECT, source_id: 'fn1', target_id: 'cls1', type: 'CALLS', props: {} },
    { project: PROJECT, source_id: 'fn2', target_id: 'cls1', type: 'CALLS', props: {} },
    { project: PROJECT, source_id: 'fn3', target_id: 'fn1', type: 'CALLS', props: {} },
  ]);
  // Edges insert with confidence DEFAULT 1.0 per schema v2.
}

describe('CypherEngine — Wave 68 regression coverage', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seed(db);
    engine = new CypherEngine(db, PROJECT);
  });
  afterEach(() => db.close());

  it('Bug 1 — target-node label filter is applied', () => {
    const result = engine.execute('MATCH (a)-[r:CALLS]->(b:Class) RETURN count(r)');
    expect(result.rows.length).toBe(1);
    // 2 Function→Class CALLS edges; the Function→Function edge must be excluded.
    expect(result.rows[0].count).toBe(2);
  });

  it('Bug 2 — anonymous-endpoint syntax parses without error', () => {
    const result = engine.execute('MATCH ()-[r:CALLS]->() RETURN count(r)');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].count).toBe(3);
  });

  it('Bug 3 — relationship-property access (r.confidence dedicated column)', () => {
    const result = engine.execute(
      "MATCH (a)-[r:CALLS]->(b) WHERE a.name = 'caller1' RETURN r.confidence",
    );
    expect(result.rows.length).toBe(1);
    // confidence column has DEFAULT 1.0; test confirms the access path works.
    expect(typeof result.rows[0].r_confidence).toBe('number');
    expect(result.rows[0].r_confidence).toBe(1.0);
  });

  it('Bug 4 — labels(n) returns the node label', () => {
    const result = engine.execute("MATCH (n) WHERE n.name = 'Foo' RETURN labels(n)");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].labels_n).toBe('Class');
  });

  it('Bug 4b — unsupported function throws clear error', () => {
    expect(() => engine.execute('MATCH (n) RETURN nonsense(n)')).toThrow(
      /unsupported function: nonsense/,
    );
  });

  it('Bug 5 — MATCH (p:Project) routes to projects table', () => {
    const result = engine.execute('MATCH (p:Project) RETURN p.name, p.indexed_at');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].p_name).toBe(PROJECT);
    expect(result.rows[0].p_indexed_at).toBe(1700000000000);
  });
});

// ─── Wave 20 — BFS prefix-collision regression ────────────────────────────────

const PREFIX_PROJECT = 'prefix-collision-test';

function seedPrefixCollision(db: GraphDatabase): void {
  db.upsertProject({
    name: PREFIX_PROJECT,
    root_path: '/tmp',
    indexed_at: 1700000000000,
    node_count: 4,
    edge_count: 3,
  });
  // Node IDs where one is a strict prefix of another — the old LIKE guard
  // 'NOT LIKE '%src.a%'' would incorrectly suppress 'src.a' when 'src.auth'
  // was already in the path string, because 'src.auth' contains 'src.a'.
  db.insertNodes([
    {
      id: 'src.a',
      project: PREFIX_PROJECT,
      label: 'Function',
      name: 'a',
      qualified_name: 'src.a',
      file_path: 'src.ts',
      start_line: 1,
      end_line: 5,
      props: {},
    },
    {
      id: 'src.auth',
      project: PREFIX_PROJECT,
      label: 'Function',
      name: 'auth',
      qualified_name: 'src.auth',
      file_path: 'src.ts',
      start_line: 7,
      end_line: 12,
      props: {},
    },
    {
      id: 'src.root',
      project: PREFIX_PROJECT,
      label: 'Function',
      name: 'root',
      qualified_name: 'src.root',
      file_path: 'src.ts',
      start_line: 14,
      end_line: 18,
      props: {},
    },
    {
      id: 'src.leaf',
      project: PREFIX_PROJECT,
      label: 'Function',
      name: 'leaf',
      qualified_name: 'src.leaf',
      file_path: 'src.ts',
      start_line: 20,
      end_line: 24,
      props: {},
    },
  ]);
  // root → src.auth → src.a → leaf
  // BFS from 'src.root' must visit src.auth, src.a, and src.leaf.
  // Under the old LIKE guard: once 'src.auth' is in the path string, any
  // traversal step checking 'src.a' would see 'src.auth' LIKE '%src.a%' = true
  // and treat it as "already visited", causing src.a to be skipped.
  db.insertEdges([
    {
      project: PREFIX_PROJECT,
      source_id: 'src.root',
      target_id: 'src.auth',
      type: 'CALLS',
      props: {},
    },
    {
      project: PREFIX_PROJECT,
      source_id: 'src.auth',
      target_id: 'src.a',
      type: 'CALLS',
      props: {},
    },
    {
      project: PREFIX_PROJECT,
      source_id: 'src.a',
      target_id: 'src.leaf',
      type: 'CALLS',
      props: {},
    },
  ]);
}

describe('CypherEngine — Wave 20 BFS prefix-collision regression', () => {
  let db: GraphDatabase;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seedPrefixCollision(db);
  });
  afterEach(() => db.close());

  it('BFS handles prefix-collision node IDs without substring confusion', () => {
    const opts: BfsOptions = {
      startNodeId: 'src.root',
      edgeTypes: ['CALLS'],
      direction: 'outbound',
      maxDepth: 5,
    };
    const rows = db.bfsTraversal(opts);
    const visitedIds = rows.map((r) => r.id);

    // Both 'src.auth' and 'src.a' must appear. The old LIKE guard suppressed
    // 'src.a' because 'src.auth' is already in the path string and the LIKE
    // check 'NOT LIKE '%src.a%'' would match 'src.auth'. The JSON1 guard
    // performs structural array-membership, so 'src.auth' ≠ 'src.a'.
    expect(visitedIds).toContain('src.auth');
    expect(visitedIds).toContain('src.a');
    expect(visitedIds).toContain('src.leaf');

    // Correct depths: src.auth at depth 1, src.a at depth 2, src.leaf at depth 3.
    expect(rows.find((r) => r.id === 'src.auth')?.depth).toBe(1);
    expect(rows.find((r) => r.id === 'src.a')?.depth).toBe(2);
    expect(rows.find((r) => r.id === 'src.leaf')?.depth).toBe(3);
  });
});

/**
 * cypherEngine.smoke.test.ts — Comprehensive smoke test fixture for CypherEngine.
 *
 * Seeds a small in-memory graph (mixed labels, multiple edge types) and exercises
 * all supported Cypher patterns end-to-end: node filters, hops, property access,
 * WHERE clauses, COUNT, labels(), ORDER BY, LIMIT, and error cases.
 *
 * Broader coverage than per-bug regression tests. Tests behavior across the full
 * surface, catching future regressions in pattern combinations.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CypherEngine } from './cypherEngine';
import { GraphDatabase } from './graphDatabase';

const PROJECT = 'smoke-test';

/**
 * Seeds a 8-node, 8-edge graph with mixed labels (Function, Class, File, Project).
 * Edge types: CALLS, DEFINES.
 */
function seed(db: GraphDatabase): void {
  db.upsertProject({
    name: PROJECT,
    root_path: '/tmp',
    indexed_at: 1700000000000,
    node_count: 8,
    edge_count: 8,
  });
  db.insertNodes([
    {
      id: 'fn1',
      project: PROJECT,
      label: 'Function',
      name: 'init',
      qualified_name: 'p.init',
      file_path: 'a.ts',
      start_line: 1,
      end_line: 10,
      props: {},
    },
    {
      id: 'fn2',
      project: PROJECT,
      label: 'Function',
      name: 'render',
      qualified_name: 'p.render',
      file_path: 'a.ts',
      start_line: 12,
      end_line: 20,
      props: {},
    },
    {
      id: 'fn3',
      project: PROJECT,
      label: 'Function',
      name: 'destroy',
      qualified_name: 'p.destroy',
      file_path: 'b.ts',
      start_line: 1,
      end_line: 5,
      props: {},
    },
    {
      id: 'fn4',
      project: PROJECT,
      label: 'Function',
      name: 'helper',
      qualified_name: 'p.helper',
      file_path: 'c.ts',
      start_line: 50,
      end_line: 60,
      props: {},
    },
    {
      id: 'cls1',
      project: PROJECT,
      label: 'Class',
      name: 'Widget',
      qualified_name: 'p.Widget',
      file_path: 'c.ts',
      start_line: 1,
      end_line: 50,
      props: {},
    },
    {
      id: 'cls2',
      project: PROJECT,
      label: 'Class',
      name: 'Container',
      qualified_name: 'p.Container',
      file_path: 'd.ts',
      start_line: 1,
      end_line: 30,
      props: {},
    },
    {
      id: 'file1',
      project: PROJECT,
      label: 'File',
      name: 'a.ts',
      qualified_name: 'p.a',
      file_path: 'a.ts',
      start_line: null,
      end_line: null,
      props: {},
    },
    {
      id: 'file2',
      project: PROJECT,
      label: 'File',
      name: 'b.ts',
      qualified_name: 'p.b',
      file_path: 'b.ts',
      start_line: null,
      end_line: null,
      props: {},
    },
  ]);
  db.insertEdges([
    { project: PROJECT, source_id: 'fn1', target_id: 'cls1', type: 'CALLS', props: {} },
    { project: PROJECT, source_id: 'fn2', target_id: 'cls1', type: 'CALLS', props: {} },
    { project: PROJECT, source_id: 'fn3', target_id: 'cls2', type: 'CALLS', props: {} },
    { project: PROJECT, source_id: 'fn4', target_id: 'cls1', type: 'CALLS', props: {} },
    { project: PROJECT, source_id: 'file1', target_id: 'fn1', type: 'DEFINES', props: {} },
    { project: PROJECT, source_id: 'file1', target_id: 'fn2', type: 'DEFINES', props: {} },
    { project: PROJECT, source_id: 'file2', target_id: 'fn3', type: 'DEFINES', props: {} },
    { project: PROJECT, source_id: 'file2', target_id: 'fn4', type: 'DEFINES', props: {} },
  ]);
}

describe('CypherEngine — Comprehensive smoke test fixture', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seed(db);
    engine = new CypherEngine(db, PROJECT);
  });
  afterEach(() => db.close());

  // ─── Single-node patterns ───────────────────────────────────────────────────

  it('Single node: MATCH (n) returns all nodes', () => {
    const result = engine.execute('MATCH (n) RETURN n.name');
    expect(result.rows.length).toBe(8);
    const names = result.rows.map((r) => r.n_name);
    expect(names).toContain('init');
    expect(names).toContain('Widget');
    expect(names).toContain('a.ts');
  });

  it('Single node with label: MATCH (n:Function) filters by label', () => {
    const result = engine.execute('MATCH (n:Function) RETURN n.name');
    expect(result.rows.length).toBe(4);
    const names = result.rows.map((r) => r.n_name);
    expect(names).toContain('init');
    expect(names).toContain('render');
    expect(names).not.toContain('Widget');
  });

  it('Single node with WHERE equality: filters by property', () => {
    const result = engine.execute("MATCH (n) WHERE n.name = 'Widget' RETURN n.qualified_name");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].n_qualified_name).toBe('p.Widget');
  });

  it('Single node with WHERE line filter: filters by start_line', () => {
    const result = engine.execute('MATCH (n:Function) WHERE n.start_line > 10 RETURN n.name');
    expect(result.rows.length).toBe(2);
    const names = result.rows.map((r) => r.n_name);
    expect(names).toContain('render');
    expect(names).toContain('helper');
  });

  // ─── Single-hop outbound patterns ────────────────────────────────────────────

  it('Single hop outbound: MATCH (a)-[r:TYPE]->(b) matches CALLS edges', () => {
    const result = engine.execute('MATCH (a)-[r:CALLS]->(b) RETURN count(r)');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].count).toBe(4);
  });

  it('Single hop with labels: MATCH (a:Function)-[r:CALLS]->(b:Class) filters both sides', () => {
    const result = engine.execute('MATCH (a:Function)-[r:CALLS]->(b:Class) RETURN a.name, b.name');
    expect(result.rows.length).toBe(4);
    const aNames = result.rows.map((r) => r.a_name);
    const bNames = result.rows.map((r) => r.b_name);
    expect(new Set(aNames)).toEqual(new Set(['init', 'render', 'destroy', 'helper']));
    expect(new Set(bNames)).toEqual(new Set(['Widget', 'Container']));
  });

  it('Single hop inbound: MATCH (a)<-[:DEFINES]-(b) reverses direction', () => {
    const result = engine.execute('MATCH (a:Function)<-[:DEFINES]-(b:File) RETURN count(*)');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].count).toBe(4);
  });

  // ─── Anonymous endpoint patterns ─────────────────────────────────────────────

  it('Anonymous left: MATCH ()-[r:CALLS]->(b:Class) returns CALLS targets', () => {
    const result = engine.execute('MATCH ()-[r:CALLS]->(b:Class) RETURN b.name');
    expect(result.rows.length).toBe(4);
  });

  it('Anonymous right: MATCH (a:File)-[:DEFINES]->() returns DEFINES targets', () => {
    const result = engine.execute('MATCH (a:File)-[:DEFINES]->() RETURN a.name');
    expect(result.rows.length).toBe(4);
  });

  it('Both anonymous with COUNT: MATCH ()-[:CALLS]->() RETURN count(*) counts all edges', () => {
    const result = engine.execute('MATCH ()-[:CALLS]->() RETURN count(*)');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].count).toBe(4);
  });

  // ─── Property access patterns ────────────────────────────────────────────────

  it('Multiple property access: RETURN n.name, n.start_line returns columns', () => {
    const result = engine.execute(
      "MATCH (n:Function) WHERE n.name = 'init' RETURN n.name, n.start_line",
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].n_name).toBe('init');
    expect(result.rows[0].n_start_line).toBe(1);
  });

  it('Edge property access: RETURN r.confidence accesses dedicated column', () => {
    const result = engine.execute('MATCH (a)-[r:CALLS]->(b) RETURN r.confidence LIMIT 1');
    expect(result.rows.length).toBe(1);
    // Default confidence from schema v2 is 1.0
    expect(typeof result.rows[0].r_confidence).toBe('number');
    expect(result.rows[0].r_confidence).toBe(1.0);
  });

  it('labels() function: RETURN labels(n) returns the node label string', () => {
    const result = engine.execute("MATCH (n) WHERE n.name = 'Widget' RETURN labels(n)");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].labels_n).toBe('Class');
  });

  it('labels() on different label: RETURN labels(n) on Function node', () => {
    const result = engine.execute("MATCH (n) WHERE n.name = 'init' RETURN labels(n)");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].labels_n).toBe('Function');
  });

  // ─── WHERE clause variants ──────────────────────────────────────────────────

  it('WHERE with AND: filters on multiple conditions', () => {
    const result = engine.execute(
      "MATCH (n:Function) WHERE n.name = 'init' AND n.start_line = 1 RETURN n.name",
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].n_name).toBe('init');
  });

  it('WHERE with comparison: filters on numeric range', () => {
    const result = engine.execute('MATCH (n:Function) WHERE n.start_line >= 12 RETURN n.name');
    expect(result.rows.length).toBe(2);
    const names = result.rows.map((r) => r.n_name);
    expect(names).toContain('render');
  });

  // ─── COUNT patterns ─────────────────────────────────────────────────────────

  it('COUNT(*): RETURN count(*) counts all matching rows', () => {
    const result = engine.execute('MATCH (n:Class) RETURN count(*)');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].count).toBe(2);
  });

  it('COUNT(n): RETURN count(n) counts all n', () => {
    const result = engine.execute('MATCH (n:Function) RETURN count(n)');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].count).toBe(4);
  });

  it('COUNT on hop: RETURN count(r) from hop query', () => {
    const result = engine.execute('MATCH (a)-[r:CALLS]->(b) RETURN count(r)');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].count).toBe(4);
  });

  // ─── ORDER BY and LIMIT ─────────────────────────────────────────────────────

  it('ORDER BY: sorts results by name ascending', () => {
    const result = engine.execute(
      'MATCH (n:Function) RETURN n.name ORDER BY n.name LIMIT 10',
    );
    const names = result.rows.map((r) => r.n_name);
    expect(names[0]).toBe('destroy');
    expect(names[names.length - 1]).toBe('render');
  });

  it('LIMIT: restricts result count', () => {
    const result = engine.execute('MATCH (n) RETURN n.name LIMIT 3');
    expect(result.rows.length).toBe(3);
  });

  it('ORDER BY DESC: sorts descending', () => {
    const result = engine.execute(
      'MATCH (n:Class) RETURN n.name ORDER BY n.name DESC LIMIT 10',
    );
    const names = result.rows.map((r) => r.n_name);
    expect(names[0]).toBe('Widget');
  });

  // ─── Project routing ────────────────────────────────────────────────────────

  it('Project node: MATCH (p:Project) routes to projects table', () => {
    const result = engine.execute('MATCH (p:Project) RETURN p.name, p.indexed_at');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].p_name).toBe(PROJECT);
    expect(result.rows[0].p_indexed_at).toBe(1700000000000);
  });

  it('Project COUNT: MATCH (p:Project) RETURN count(*)', () => {
    const result = engine.execute('MATCH (p:Project) RETURN count(*)');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].count).toBe(1);
  });

  // ─── DISTINCT ───────────────────────────────────────────────────────────────

  it('DISTINCT: removes duplicate values from results', () => {
    // file_path is duplicated across multiple nodes; DISTINCT should reduce results
    const result = engine.execute('MATCH (n) RETURN DISTINCT n.file_path');
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThanOrEqual(4);
  });

  // ─── Error cases ────────────────────────────────────────────────────────────

  it('Unsupported function: throws clear error', () => {
    expect(() => engine.execute('MATCH (n) RETURN nonsense(n)')).toThrow(
      /unsupported function: nonsense/,
    );
  });

  it('Missing MATCH clause: throws error', () => {
    expect(() => engine.execute('RETURN n.name')).toThrow(/must contain a MATCH clause/);
  });

  it('Missing RETURN clause: throws error', () => {
    expect(() => engine.execute('MATCH (n)')).toThrow(/must contain a RETURN clause/);
  });

  it('Write operation: throws read-only error', () => {
    expect(() => engine.execute('CREATE (n:Test)')).toThrow(/Only read-only queries are allowed/);
  });

  // ─── Multi-edge-type patterns ───────────────────────────────────────────────

  it('CALLS vs DEFINES: filter by edge type', () => {
    const callsResult = engine.execute('MATCH (a)-[r:CALLS]->(b) RETURN count(r)');
    const definesResult = engine.execute('MATCH (a)-[r:DEFINES]->(b) RETURN count(r)');
    expect(callsResult.rows[0].count).toBe(4);
    expect(definesResult.rows[0].count).toBe(4);
  });

  it('File node with qualified_name: accesses qualified_name property', () => {
    const result = engine.execute(
      "MATCH (f:File) WHERE f.name = 'a.ts' RETURN f.qualified_name",
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].f_qualified_name).toBe('p.a');
  });

  // ─── Complex patterns ───────────────────────────────────────────────────────

  it('Complex: Functions with WHERE and ORDER BY', () => {
    const result = engine.execute(
      'MATCH (n:Function) WHERE n.start_line < 20 RETURN n.name, n.start_line ORDER BY n.start_line DESC LIMIT 10',
    );
    expect(result.rows.length).toBeGreaterThan(0);
    const firstLine = result.rows[0].n_start_line as number;
    if (result.rows.length > 1) {
      const secondLine = result.rows[1].n_start_line as number;
      expect(firstLine).toBeGreaterThanOrEqual(secondLine);
    }
  });

  it('Complex: Hop with WHERE on target property', () => {
    const result = engine.execute(
      "MATCH (a)-[r:CALLS]->(b) WHERE b.name = 'Widget' RETURN a.name",
    );
    expect(result.rows.length).toBe(3);
    const aNames = result.rows.map((r) => r.a_name);
    expect(new Set(aNames)).toEqual(new Set(['init', 'render', 'helper']));
  });
});

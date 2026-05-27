/**
 * cypherEngine.test.ts — Wave-77 regression entry point.
 *
 * Comprehensive coverage lives in the co-located specialised suites:
 *   cypherEngine.smoke.test.ts         — full surface smoke tests
 *   cypherEngine.propsAndIn.test.ts    — Wave-68b props/IN regression
 *   cypherEngineRegression.test.ts     — Wave-68 per-bug regression
 *   cypherEngineNewFeatures.test.ts    — Wave-77 UNWIND + OPTIONAL MATCH
 *
 * This file provides a minimal integration smoke over the public execute()
 * contract so the test-required hook is satisfied and regressions in the
 * entry-point itself are caught.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CypherEngine } from './cypherEngine';
import { GraphDatabase } from './graphDatabase';

const PROJECT = 'engine-entry-test';

function seed(db: GraphDatabase): void {
  db.upsertProject({ name: PROJECT, root_path: '/tmp', indexed_at: 1000, node_count: 2, edge_count: 1 });
  db.insertNodes([
    { id: 'n1', project: PROJECT, label: 'Function', name: 'foo', qualified_name: `${PROJECT}.foo`, file_path: 'a.ts', start_line: 1, end_line: 5, props: {} },
    { id: 'n2', project: PROJECT, label: 'Class', name: 'Bar', qualified_name: `${PROJECT}.Bar`, file_path: 'b.ts', start_line: 1, end_line: 10, props: {} },
  ]);
  db.insertEdges([{ project: PROJECT, source_id: 'n1', target_id: 'n2', type: 'CALLS', props: {} }]);
}

describe('CypherEngine.execute — entry point contract', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => { db = new GraphDatabase(':memory:'); seed(db); engine = new CypherEngine(db, PROJECT); });
  afterEach(() => db.close());

  it('returns CypherQueryResult shape', () => {
    const r = engine.execute('MATCH (n:Function) RETURN n.name');
    expect(r).toHaveProperty('columns');
    expect(r).toHaveProperty('rows');
    expect(r).toHaveProperty('total');
  });

  it('single-node query returns matching rows', () => {
    const r = engine.execute('MATCH (n:Function) RETURN n.name');
    expect(r.total).toBe(1);
    expect(r.rows[0].n_name).toBe('foo');
  });

  it('hop query returns edge matches', () => {
    const r = engine.execute('MATCH (a:Function)-[:CALLS]->(b:Class) RETURN a.name, b.name');
    expect(r.total).toBe(1);
    expect(r.rows[0].a_name).toBe('foo');
    expect(r.rows[0].b_name).toBe('Bar');
  });

  it('WITH clause throws structured error', () => {
    expect(() => engine.execute('WITH 1 AS x MATCH (n) RETURN n.name')).toThrow(/Cypher feature not supported.*WITH/);
  });

  it('write query throws read-only error', () => {
    expect(() => engine.execute('CREATE (n:Test)')).toThrow(/read-only/);
  });

  it('missing MATCH throws helpful error', () => {
    expect(() => engine.execute('RETURN n.name')).toThrow(/MATCH clause/);
  });

  it('OPTIONAL MATCH returns null for unmatched rows', () => {
    const r = engine.execute('MATCH (n:Class) OPTIONAL MATCH (n)-[:CALLS]->(m) RETURN n.name, m.name');
    expect(r.total).toBe(1);
    expect(r.rows[0].n_name).toBe('Bar');
    expect(r.rows[0].m_name).toBeNull();
  });

  it('UNWIND literal list returns matching nodes', () => {
    const r = engine.execute("UNWIND ['foo'] AS name MATCH (n) RETURN n.name");
    expect(r.total).toBe(1);
    expect(r.rows[0].n_name).toBe('foo');
  });
});

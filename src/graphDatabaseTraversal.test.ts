/**
 * graphDatabaseTraversal.test.ts — Security + correctness tests for runBfsTraversal.
 *
 * Covers:
 *   1. Param-ordering correctness: a transposed param (edgeType landing where
 *      maxDepth belongs) produces wrong rows — exact reachable-node-set assertions
 *      catch silent misbinding.
 *   2. Injection safety: a malicious edge-type string must be treated as data
 *      (zero matches, no throw, table intact) — not executed as SQL.
 *   3. maxDepth bound enforcement (verifies depth param is correctly bound, not
 *      swapped with an edge-type string).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GraphDatabase } from './graphDatabase';
import type { BfsOptions } from './graphDatabaseTraversal';
import type { NodeLabel } from './graphDatabaseTypes';

// ─── Fixture ─────────────────────────────────────────────────────────────────
//
//  Graph topology (two edge types, three depths):
//
//    a --CALLS--> b --CALLS--> c --CALLS--> d
//                b --IMPORTS-> e
//
//  BFS from `a` with type=CALLS  → {b, c, d}   (not e)
//  BFS from `a` with type=IMPORTS → {}           (a has no IMPORTS edge)
//  BFS from `b` with type=IMPORTS → {e}
//  BFS from `a` with [CALLS,IMPORTS] → {b, c, d, e}
//  BFS from `a` with type=CALLS, maxDepth=1 → {b}

const BFS_PROJECT = 'bfs-traversal-test';

function seedBfs(db: GraphDatabase): void {
  db.upsertProject({
    name: BFS_PROJECT,
    root_path: '/tmp',
    indexed_at: 1700000000000,
    node_count: 5,
    edge_count: 4,
  });
  const fn = (id: string, name: string): {
    id: string; project: string; label: NodeLabel; name: string;
    qualified_name: string; file_path: string; start_line: number; end_line: number; props: Record<string, unknown>;
  } => ({
    id,
    project: BFS_PROJECT,
    label: 'Function' as NodeLabel,
    name,
    qualified_name: `${BFS_PROJECT}.${name}`,
    file_path: 'f.ts',
    start_line: 1,
    end_line: 2,
    props: {},
  });
  db.insertNodes([fn('a', 'a'), fn('b', 'b'), fn('c', 'c'), fn('d', 'd'), fn('e', 'e')]);
  db.insertEdges([
    { project: BFS_PROJECT, source_id: 'a', target_id: 'b', type: 'CALLS', props: {} },
    { project: BFS_PROJECT, source_id: 'b', target_id: 'c', type: 'CALLS', props: {} },
    { project: BFS_PROJECT, source_id: 'c', target_id: 'd', type: 'CALLS', props: {} },
    { project: BFS_PROJECT, source_id: 'b', target_id: 'e', type: 'IMPORTS', props: {} },
  ]);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runBfsTraversal — param ordering and injection safety', () => {
  let db: GraphDatabase;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seedBfs(db);
  });
  afterEach(() => db.close());

  it('CALLS-filtered BFS from `a` reaches exactly {b,c,d} and excludes `e`', () => {
    // If edgeType param is misplaced (e.g. lands where maxDepth belongs), SQLite
    // coerces 'CALLS' → 0, so nothing is reachable, OR the type filter is absent
    // and `e` is included. Either failure is caught by the exact-set assertion.
    const opts: BfsOptions = {
      startNodeId: 'a',
      edgeTypes: ['CALLS'],
      direction: 'outbound',
      maxDepth: 10,
    };
    const rows = db.bfsTraversal(opts);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['b', 'c', 'd']);
  });

  it('IMPORTS-filtered BFS from `b` reaches exactly {e}', () => {
    const opts: BfsOptions = {
      startNodeId: 'b',
      edgeTypes: ['IMPORTS'],
      direction: 'outbound',
      maxDepth: 10,
    };
    const rows = db.bfsTraversal(opts);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(['e']);
  });

  it('CALLS-filtered BFS from `a` with maxDepth=1 reaches only {b} (depth bound enforced)', () => {
    // If edgeTypes and maxDepth params are transposed, 'CALLS' coerces to 0 and
    // nothing is reachable — the assertion fails rather than silently passing.
    const opts: BfsOptions = {
      startNodeId: 'a',
      edgeTypes: ['CALLS'],
      direction: 'outbound',
      maxDepth: 1,
    };
    const rows = db.bfsTraversal(opts);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(['b']);
  });

  it('union of [CALLS, IMPORTS] from `a` reaches {b,c,d,e}', () => {
    const opts: BfsOptions = {
      startNodeId: 'a',
      edgeTypes: ['CALLS', 'IMPORTS'],
      direction: 'outbound',
      maxDepth: 10,
    };
    const rows = db.bfsTraversal(opts);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['b', 'c', 'd', 'e']);
  });

  it('IMPORTS-filtered BFS from `a` returns no rows (a has no IMPORTS edges)', () => {
    const opts: BfsOptions = {
      startNodeId: 'a',
      edgeTypes: ['IMPORTS'],
      direction: 'outbound',
      maxDepth: 10,
    };
    const rows = db.bfsTraversal(opts);
    expect(rows).toHaveLength(0);
  });

  it('injection safety: malicious edge-type string yields zero rows and does not throw', () => {
    // The type value is bound via ?, not inlined. If the old interpolation path were
    // active, SQLite would throw a syntax error or silently corrupt data.
    const malicious = "'); DROP TABLE nodes;--";
    const opts: BfsOptions = {
      startNodeId: 'a',
      edgeTypes: [malicious],
      direction: 'outbound',
      maxDepth: 10,
    };
    expect(() => db.bfsTraversal(opts)).not.toThrow();
    const rows = db.bfsTraversal(opts);
    expect(rows).toHaveLength(0);
    // Nodes table must still be intact — if DROP TABLE executed, this would throw.
    expect(() => db.rawQuery('SELECT COUNT(*) FROM nodes', [])).not.toThrow();
  });
});

// ─── minConfidence param-ordering tests ──────────────────────────────────────
//
// Graph: a --CALLS(conf=1.0)--> b --CALLS(conf=0.3)--> c
//
// BFS with minConfidence=0.5 from `a`: only a→b survives (b→c is conf=0.3 < 0.5),
// so reachable = {b} only.
// BFS with minConfidence=0 (no filter): both edges traverse → {b, c}.
// If minConfidence were mis-ordered (e.g. swapped with maxDepth), SQLite would bind
// 0.5 as maxDepth (rounds to 0) → zero rows, or bind maxDepth as confidence → wrong filter.

const BFS_CONF_PROJECT = 'bfs-confidence-test';

function seedBfsConfidence(db: GraphDatabase): void {
  db.upsertProject({
    name: BFS_CONF_PROJECT,
    root_path: '/tmp',
    indexed_at: 1700000000000,
    node_count: 3,
    edge_count: 2,
  });
  const fn = (id: string, name: string): {
    id: string; project: string; label: NodeLabel; name: string;
    qualified_name: string; file_path: string; start_line: number; end_line: number; props: Record<string, unknown>;
  } => ({
    id,
    project: BFS_CONF_PROJECT,
    label: 'Function' as NodeLabel,
    name,
    qualified_name: `${BFS_CONF_PROJECT}.${name}`,
    file_path: 'f.ts',
    start_line: 1,
    end_line: 2,
    props: {},
  });
  db.insertNodes([fn('ca', 'a'), fn('cb', 'b'), fn('cc', 'c')]);
  db.insertEdges([
    { project: BFS_CONF_PROJECT, source_id: 'ca', target_id: 'cb', type: 'CALLS', confidence: 1.0, props: {} },
    { project: BFS_CONF_PROJECT, source_id: 'cb', target_id: 'cc', type: 'CALLS', confidence: 0.3, props: {} },
  ]);
}

describe('runBfsTraversal — minConfidence param ordering', () => {
  let db: GraphDatabase;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seedBfsConfidence(db);
  });
  afterEach(() => db.close());

  it('minConfidence=0.5 excludes the low-confidence edge (b→c) — only {b} reachable from a', () => {
    // If minConfidence is mis-ordered relative to maxDepth, SQLite coerces 0.5→0 as depth,
    // yielding zero rows — the assertion fails rather than silently passing.
    const opts: BfsOptions = {
      startNodeId: 'ca',
      edgeTypes: ['CALLS'],
      direction: 'outbound',
      maxDepth: 10,
      minConfidence: 0.5,
    };
    const rows = db.bfsTraversal(opts);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(['cb']);
  });

  it('minConfidence=0 (no filter) allows both edges — {b,c} reachable from a', () => {
    // Verifies the applyConfidence=false path leaves the args array unchanged.
    const opts: BfsOptions = {
      startNodeId: 'ca',
      edgeTypes: ['CALLS'],
      direction: 'outbound',
      maxDepth: 10,
      minConfidence: 0,
    };
    const rows = db.bfsTraversal(opts);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['cb', 'cc']);
  });

  it('minConfidence=undefined (omitted) also traverses all edges — {b,c} reachable from a', () => {
    const opts: BfsOptions = {
      startNodeId: 'ca',
      edgeTypes: ['CALLS'],
      direction: 'outbound',
      maxDepth: 10,
    };
    const rows = db.bfsTraversal(opts);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['cb', 'cc']);
  });
});

/**
 * graphDatabaseHelpers.deleteOutboundEdges.test.ts
 *
 * Load-bearing scoping tests for deleteOutboundEdgesOfType (D5).
 *
 * The method must:
 *   (a) delete project-internal outbound edges of the given type for the given source
 *   (b) NOT delete edges of other types from the same source
 *   (c) NOT delete edges of the same type from other source nodes
 *   (d) NOT delete edges of the same (source, type) pair belonging to a DIFFERENT project
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GraphDatabase } from './graphDatabase';
import type { GraphNode, ProjectRecord } from './graphDatabaseTypes';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeProject(name: string, overrides?: Partial<ProjectRecord>): ProjectRecord {
  return {
    name,
    root_path: `/home/user/${name}`,
    indexed_at: Date.now(),
    node_count: 0,
    edge_count: 0,
    ...overrides,
  };
}

function makeNode(id: string, project: string, overrides?: Partial<GraphNode>): GraphNode {
  return {
    id,
    project,
    label: 'Function',
    name: id.split('::').pop() ?? id,
    qualified_name: id,
    file_path: 'src/a.ts',
    start_line: 1,
    end_line: 10,
    props: {},
    ...overrides,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('GraphDatabase.deleteOutboundEdgesOfType', () => {
  let db: GraphDatabase;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    // Two projects: alpha and beta
    db.upsertProject(makeProject('alpha'));
    db.upsertProject(makeProject('beta'));

    // Nodes in project alpha
    db.insertNode(makeNode('alpha::src/a.ts::caller', 'alpha'));
    db.insertNode(makeNode('alpha::src/b.ts::targetA', 'alpha'));
    db.insertNode(makeNode('alpha::src/c.ts::targetB', 'alpha'));
    db.insertNode(makeNode('alpha::src/d.ts::otherSource', 'alpha'));

    // Node in project beta with the same logical id as the alpha caller
    db.insertNode(makeNode('alpha::src/a.ts::caller', 'beta'));
    db.insertNode(makeNode('beta::src/b.ts::targetBeta', 'beta'));
  });

  afterEach(() => {
    db.close();
  });

  it('(a) deletes the project-internal outbound CALLS edges for the given source', () => {
    // Insert two CALLS edges from the caller in alpha
    db.insertEdge({
      project: 'alpha',
      source_id: 'alpha::src/a.ts::caller',
      target_id: 'alpha::src/b.ts::targetA',
      type: 'CALLS',
      props: {},
      confidence: 0.9,
    });
    db.insertEdge({
      project: 'alpha',
      source_id: 'alpha::src/a.ts::caller',
      target_id: 'alpha::src/c.ts::targetB',
      type: 'CALLS',
      props: {},
      confidence: 0.9,
    });

    db.deleteOutboundEdgesOfType('alpha', 'alpha::src/a.ts::caller', 'CALLS');

    const remaining = db.getOutboundEdges('alpha::src/a.ts::caller', 'CALLS');
    // All CALLS edges from this source in project alpha must be gone
    const alphaRemaining = remaining.filter((e) => e.project === 'alpha');
    expect(alphaRemaining).toHaveLength(0);
  });

  it('(b) does NOT delete edges of other types from the same source', () => {
    db.insertEdge({
      project: 'alpha',
      source_id: 'alpha::src/a.ts::caller',
      target_id: 'alpha::src/b.ts::targetA',
      type: 'CALLS',
      props: {},
      confidence: 0.9,
    });
    db.insertEdge({
      project: 'alpha',
      source_id: 'alpha::src/a.ts::caller',
      target_id: 'alpha::src/c.ts::targetB',
      type: 'TYPEOF_REFERENCES',
      props: {},
      confidence: 0.85,
    });

    // Delete only CALLS from this source in alpha
    db.deleteOutboundEdgesOfType('alpha', 'alpha::src/a.ts::caller', 'CALLS');

    // TYPEOF_REFERENCES edge must survive
    const typeofEdges = db.getOutboundEdges('alpha::src/a.ts::caller', 'TYPEOF_REFERENCES');
    const surviving = typeofEdges.filter((e) => e.project === 'alpha');
    expect(surviving).toHaveLength(1);
    expect(surviving[0].type).toBe('TYPEOF_REFERENCES');
    expect(surviving[0].target_id).toBe('alpha::src/c.ts::targetB');
  });

  it('(c) does NOT delete edges of the same type from other source nodes in the same project', () => {
    // CALLS from the target source (otherSource)
    db.insertEdge({
      project: 'alpha',
      source_id: 'alpha::src/d.ts::otherSource',
      target_id: 'alpha::src/b.ts::targetA',
      type: 'CALLS',
      props: {},
      confidence: 0.9,
    });
    // CALLS from the caller source (to be deleted)
    db.insertEdge({
      project: 'alpha',
      source_id: 'alpha::src/a.ts::caller',
      target_id: 'alpha::src/b.ts::targetA',
      type: 'CALLS',
      props: {},
      confidence: 0.9,
    });

    db.deleteOutboundEdgesOfType('alpha', 'alpha::src/a.ts::caller', 'CALLS');

    // otherSource's CALLS edge must survive
    const otherSourceEdges = db.getOutboundEdges('alpha::src/d.ts::otherSource', 'CALLS');
    const alphaOther = otherSourceEdges.filter((e) => e.project === 'alpha');
    expect(alphaOther).toHaveLength(1);
    expect(alphaOther[0].source_id).toBe('alpha::src/d.ts::otherSource');
  });

  it('(d) does NOT delete edges of the same (source, type) pair belonging to a different project', () => {
    // Same logical source_id string, but in project beta
    db.insertEdge({
      project: 'beta',
      source_id: 'alpha::src/a.ts::caller', // same string, different project
      target_id: 'beta::src/b.ts::targetBeta',
      type: 'CALLS',
      props: {},
      confidence: 0.9,
    });
    // Also insert one in alpha so we have something to delete
    db.insertEdge({
      project: 'alpha',
      source_id: 'alpha::src/a.ts::caller',
      target_id: 'alpha::src/b.ts::targetA',
      type: 'CALLS',
      props: {},
      confidence: 0.9,
    });

    // Delete only within project alpha
    db.deleteOutboundEdgesOfType('alpha', 'alpha::src/a.ts::caller', 'CALLS');

    // Beta's edge with the same source_id string must survive
    const betaEdges = db.getOutboundEdges('alpha::src/a.ts::caller', 'CALLS');
    const betaOnly = betaEdges.filter((e) => e.project === 'beta');
    expect(betaOnly).toHaveLength(1);
    expect(betaOnly[0].target_id).toBe('beta::src/b.ts::targetBeta');
  });
});

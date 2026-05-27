import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GraphDatabase } from './graphDatabase';
import type { GraphEdge, GraphNode, ProjectRecord } from './graphDatabaseTypes';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProject(overrides?: Partial<ProjectRecord>): ProjectRecord {
  return {
    name: 'test-project',
    root_path: '/home/user/test-project',
    indexed_at: Date.now(),
    node_count: 0,
    edge_count: 0,
    ...overrides,
  };
}

function makeNode(overrides?: Partial<GraphNode>): GraphNode {
  return {
    id: 'test-project::src/utils.ts::parseConfig',
    project: 'test-project',
    label: 'Function',
    name: 'parseConfig',
    qualified_name: 'test-project::src/utils.ts::parseConfig',
    file_path: 'src/utils.ts',
    start_line: 10,
    end_line: 25,
    props: { is_exported: true, is_entry_point: false },
    ...overrides,
  };
}

function makeEdge(overrides?: Partial<Omit<GraphEdge, 'id'>>): Omit<GraphEdge, 'id'> {
  return {
    project: 'test-project',
    source_id: 'test-project::src/main.ts::main',
    target_id: 'test-project::src/utils.ts::parseConfig',
    type: 'CALLS',
    props: {},
    ...overrides,
  };
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('GraphDatabase', () => {
  let db: GraphDatabase;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  // ─── Project CRUD ────────────────────────────────────────────────────

  describe('project operations', () => {
    it('creates and retrieves a project', () => {
      const project = makeProject();
      db.upsertProject(project);

      const result = db.getProject('test-project');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('test-project');
      expect(result!.root_path).toBe('/home/user/test-project');
    });

    it('returns null for non-existent project', () => {
      expect(db.getProject('nope')).toBeNull();
    });

    it('upserts a project (update existing)', () => {
      db.upsertProject(makeProject());
      db.upsertProject(makeProject({ indexed_at: 999, node_count: 42 }));

      const result = db.getProject('test-project');
      expect(result!.indexed_at).toBe(999);
      expect(result!.node_count).toBe(42);
    });

    it('lists all projects', () => {
      db.upsertProject(makeProject({ name: 'alpha' }));
      db.upsertProject(makeProject({ name: 'beta' }));

      const projects = db.listProjects();
      expect(projects).toHaveLength(2);
      expect(projects.map((p) => p.name)).toEqual(['alpha', 'beta']);
    });

    it('deletes a project', () => {
      db.upsertProject(makeProject());
      db.deleteProject('test-project');

      expect(db.getProject('test-project')).toBeNull();
    });

    it('cascade deletes nodes and edges when project is deleted', () => {
      db.upsertProject(makeProject());

      const nodeA = makeNode({ id: 'n1', qualified_name: 'n1', name: 'main' });
      const nodeB = makeNode({ id: 'n2', qualified_name: 'n2', name: 'helper' });
      db.insertNode(nodeA);
      db.insertNode(nodeB);
      db.insertEdge(makeEdge({ source_id: 'n1', target_id: 'n2' }));

      expect(db.getNodeCount('test-project')).toBe(2);
      expect(db.getEdgeCount('test-project')).toBe(1);

      db.deleteProject('test-project');

      expect(db.getNodeCount('test-project')).toBe(0);
      expect(db.getEdgeCount('test-project')).toBe(0);
    });
  });

  // ─── Node CRUD ──────────────────────────────────────────────────────

  describe('node operations', () => {
    beforeEach(() => {
      db.upsertProject(makeProject());
    });

    it('inserts and retrieves a node', () => {
      const node = makeNode();
      db.insertNode(node);

      const result = db.getNode(node.id);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('parseConfig');
      expect(result!.label).toBe('Function');
      expect(result!.props.is_exported).toBe(true);
    });

    it('returns null for non-existent node', () => {
      expect(db.getNode('does-not-exist')).toBeNull();
    });

    it('inserts multiple nodes in a batch', () => {
      const nodes = [
        makeNode({ id: 'n1', qualified_name: 'n1', name: 'funcA' }),
        makeNode({ id: 'n2', qualified_name: 'n2', name: 'funcB' }),
        makeNode({ id: 'n3', qualified_name: 'n3', name: 'funcC' }),
      ];
      db.insertNodes(nodes);

      expect(db.getNodeCount('test-project')).toBe(3);
      expect(db.getNode('n1')!.name).toBe('funcA');
      expect(db.getNode('n2')!.name).toBe('funcB');
      expect(db.getNode('n3')!.name).toBe('funcC');
    });

    it('gets nodes by label', () => {
      db.insertNodes([
        makeNode({ id: 'f1', qualified_name: 'f1', name: 'fn1', label: 'Function' }),
        makeNode({ id: 'c1', qualified_name: 'c1', name: 'MyClass', label: 'Class' }),
        makeNode({ id: 'f2', qualified_name: 'f2', name: 'fn2', label: 'Function' }),
      ]);

      const functions = db.getNodesByLabel('test-project', 'Function');
      expect(functions).toHaveLength(2);
      expect(functions.map((n) => n.name).sort()).toEqual(['fn1', 'fn2']);
    });

    it('gets nodes by file path', () => {
      db.insertNodes([
        makeNode({ id: 'a', qualified_name: 'a', name: 'a', file_path: 'src/foo.ts' }),
        makeNode({ id: 'b', qualified_name: 'b', name: 'b', file_path: 'src/bar.ts' }),
        makeNode({ id: 'c', qualified_name: 'c', name: 'c', file_path: 'src/foo.ts' }),
      ]);

      const fooNodes = db.getNodesByFile('test-project', 'src/foo.ts');
      expect(fooNodes).toHaveLength(2);
    });

    it('deletes nodes by file path', () => {
      db.insertNodes([
        makeNode({ id: 'a', qualified_name: 'a', name: 'a', file_path: 'src/foo.ts' }),
        makeNode({ id: 'b', qualified_name: 'b', name: 'b', file_path: 'src/bar.ts' }),
      ]);

      db.deleteNodesByFile('test-project', 'src/foo.ts');
      expect(db.getNodeCount('test-project')).toBe(1);
      expect(db.getNode('a')).toBeNull();
      expect(db.getNode('b')).not.toBeNull();
    });

    it('deletes all nodes by project', () => {
      db.insertNodes([
        makeNode({ id: 'a', qualified_name: 'a', name: 'a' }),
        makeNode({ id: 'b', qualified_name: 'b', name: 'b' }),
      ]);

      db.deleteNodesByProject('test-project');
      expect(db.getNodeCount('test-project')).toBe(0);
    });

    it('replaces a node on re-insert (INSERT OR REPLACE)', () => {
      db.insertNode(makeNode({ props: { version: 1 } }));
      db.insertNode(makeNode({ props: { version: 2 } }));

      const result = db.getNode(makeNode().id);
      expect(result!.props.version).toBe(2);
      expect(db.getNodeCount('test-project')).toBe(1);
    });

    it('updates node props', () => {
      db.insertNode(makeNode());
      db.updateNodeProps(makeNode().id, { is_exported: false, new_field: 'hello' });

      const result = db.getNode(makeNode().id);
      expect(result!.props.is_exported).toBe(false);
      expect(result!.props.new_field).toBe('hello');
    });
  });

  // ─── Edge CRUD ──────────────────────────────────────────────────────

  describe('edge operations', () => {
    beforeEach(() => {
      db.upsertProject(makeProject());
      db.insertNodes([
        makeNode({ id: 'main', qualified_name: 'main', name: 'main' }),
        makeNode({ id: 'parseConfig', qualified_name: 'parseConfig', name: 'parseConfig' }),
        makeNode({ id: 'validate', qualified_name: 'validate', name: 'validate' }),
      ]);
    });

    it('inserts and retrieves outbound edges', () => {
      db.insertEdge(makeEdge({ source_id: 'main', target_id: 'parseConfig' }));

      const edges = db.getOutboundEdges('main');
      expect(edges).toHaveLength(1);
      expect(edges[0].target_id).toBe('parseConfig');
      expect(edges[0].type).toBe('CALLS');
    });

    it('retrieves inbound edges', () => {
      db.insertEdge(makeEdge({ source_id: 'main', target_id: 'parseConfig' }));

      const edges = db.getInboundEdges('parseConfig');
      expect(edges).toHaveLength(1);
      expect(edges[0].source_id).toBe('main');
    });

    it('filters edges by type', () => {
      db.insertEdge(makeEdge({ source_id: 'main', target_id: 'parseConfig', type: 'CALLS' }));
      db.insertEdge(makeEdge({ source_id: 'main', target_id: 'validate', type: 'IMPORTS' }));

      const callEdges = db.getOutboundEdges('main', 'CALLS');
      expect(callEdges).toHaveLength(1);
      expect(callEdges[0].target_id).toBe('parseConfig');

      const importEdges = db.getOutboundEdges('main', 'IMPORTS');
      expect(importEdges).toHaveLength(1);
      expect(importEdges[0].target_id).toBe('validate');
    });

    it('inserts multiple edges in a batch', () => {
      db.insertEdges([
        makeEdge({ source_id: 'main', target_id: 'parseConfig', type: 'CALLS' }),
        makeEdge({ source_id: 'main', target_id: 'validate', type: 'CALLS' }),
        makeEdge({ source_id: 'parseConfig', target_id: 'validate', type: 'CALLS' }),
      ]);

      expect(db.getEdgeCount('test-project')).toBe(3);
    });

    it('replaces duplicate edge (same source, target, type)', () => {
      db.insertEdge(
        makeEdge({ source_id: 'main', target_id: 'parseConfig', props: { weight: 1 } }),
      );
      db.insertEdge(
        makeEdge({ source_id: 'main', target_id: 'parseConfig', props: { weight: 2 } }),
      );

      const edges = db.getOutboundEdges('main', 'CALLS');
      expect(edges).toHaveLength(1);
      expect(edges[0].props.weight).toBe(2);
    });

    it('deletes edges by project', () => {
      db.insertEdges([
        makeEdge({ source_id: 'main', target_id: 'parseConfig' }),
        makeEdge({ source_id: 'main', target_id: 'validate' }),
      ]);

      db.deleteEdgesByProject('test-project');
      expect(db.getEdgeCount('test-project')).toBe(0);
    });
  });

  // ─── FTS5 search ────────────────────────────────────────────────────

  describe('FTS5 search', () => {
    beforeEach(() => {
      db.upsertProject(makeProject());
      db.insertNodes([
        makeNode({
          id: 'n1',
          qualified_name: 'test-project::src/config.ts::parseConfig',
          name: 'parseConfig',
          file_path: 'src/config.ts',
        }),
        makeNode({
          id: 'n2',
          qualified_name: 'test-project::src/validate.ts::validateInput',
          name: 'validateInput',
          file_path: 'src/validate.ts',
        }),
        makeNode({
          id: 'n3',
          qualified_name: 'test-project::src/config.ts::loadConfig',
          name: 'loadConfig',
          file_path: 'src/config.ts',
        }),
      ]);
    });

    it('finds nodes by name substring via trigram FTS', () => {
      // Trigram tokenizer matches substrings of 3+ chars
      const results = db.searchNodesFts('parse');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((n) => n.name === 'parseConfig')).toBe(true);
    });

    it('finds nodes by qualified name', () => {
      const results = db.searchNodesFts('config');
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('finds nodes by file path', () => {
      const results = db.searchNodesFts('validate');
      expect(results.some((n) => n.file_path === 'src/validate.ts')).toBe(true);
    });

    it('returns empty for no matches', () => {
      const results = db.searchNodesFts('zzzznotfound');
      expect(results).toHaveLength(0);
    });

    it('respects limit parameter', () => {
      const results = db.searchNodesFts('Config', 1);
      expect(results).toHaveLength(1);
    });

    it('FTS stays in sync after node deletion', () => {
      // Delete the parseConfig node
      db.deleteNodesByFile('test-project', 'src/config.ts');

      // FTS should no longer match deleted nodes
      const results = db.searchNodesFts('parseConfig');
      expect(results.every((n) => n.name !== 'parseConfig')).toBe(true);
    });

    it('FTS stays in sync after node update (INSERT OR REPLACE)', () => {
      // Re-insert with different name
      db.insertNode(
        makeNode({
          id: 'n1',
          qualified_name: 'test-project::src/config.ts::parseConfig',
          name: 'renamedFunction',
          file_path: 'src/config.ts',
        }),
      );

      const results = db.searchNodesFts('renamedFunc');
      expect(results.some((n) => n.name === 'renamedFunction')).toBe(true);
    });
  });

  // ─── searchNodes (dynamic filter) ──────────────────────────────────

  describe('searchNodes', () => {
    beforeEach(() => {
      db.upsertProject(makeProject());
      db.insertNodes([
        makeNode({
          id: 'f1',
          qualified_name: 'f1',
          name: 'parseConfig',
          label: 'Function',
          file_path: 'src/config.ts',
          props: { is_exported: true, is_entry_point: false },
        }),
        makeNode({
          id: 'f2',
          qualified_name: 'f2',
          name: 'validateInput',
          label: 'Function',
          file_path: 'src/validate.ts',
          props: { is_exported: true, is_entry_point: true },
        }),
        makeNode({
          id: 'c1',
          qualified_name: 'c1',
          name: 'ConfigManager',
          label: 'Class',
          file_path: 'src/config.ts',
          props: { is_exported: true, is_entry_point: false },
        }),
        makeNode({
          id: 'i1',
          qualified_name: 'i1',
          name: 'IValidator',
          label: 'Interface',
          file_path: 'src/validate.ts',
          props: { is_exported: false, is_entry_point: false },
        }),
      ]);
    });

    it('returns all nodes with empty filter', () => {
      const result = db.searchNodes({});
      expect(result.total).toBe(4);
      expect(result.nodes).toHaveLength(4);
      expect(result.has_more).toBe(false);
    });

    it('filters by project', () => {
      const result = db.searchNodes({ project: 'test-project' });
      expect(result.total).toBe(4);
    });

    it('filters by label', () => {
      const result = db.searchNodes({ label: 'Function' });
      expect(result.total).toBe(2);
    });

    it('filters by name pattern (case-insensitive)', () => {
      const result = db.searchNodes({ namePattern: 'config' });
      expect(result.total).toBe(2); // parseConfig + ConfigManager
    });

    it('filters by name pattern (case-sensitive)', () => {
      const result = db.searchNodes({ namePattern: 'Config', caseSensitive: true });
      expect(result.total).toBe(2); // parseConfig + ConfigManager (both contain "Config")
    });

    it('filters by file path', () => {
      const result = db.searchNodes({ filePath: 'validate.ts' });
      expect(result.total).toBe(2);
    });

    it('supports pagination', () => {
      const page1 = db.searchNodes({ limit: 2, offset: 0 });
      expect(page1.nodes).toHaveLength(2);
      expect(page1.total).toBe(4);
      expect(page1.has_more).toBe(true);

      const page2 = db.searchNodes({ limit: 2, offset: 2 });
      expect(page2.nodes).toHaveLength(2);
      expect(page2.has_more).toBe(false);
    });

    it('filters by excludeEntryPoints', () => {
      const result = db.searchNodes({ excludeEntryPoints: true });
      expect(result.nodes.every((n) => n.props.is_entry_point !== 1)).toBe(true);
    });

    it('combines multiple filters', () => {
      const result = db.searchNodes({
        project: 'test-project',
        label: 'Function',
        filePath: 'config.ts',
      });
      expect(result.total).toBe(1);
      expect(result.nodes[0].name).toBe('parseConfig');
    });
  });

  // ─── Degree queries ─────────────────────────────────────────────────

  describe('degree queries', () => {
    beforeEach(() => {
      db.upsertProject(makeProject());
      db.insertNodes([
        makeNode({ id: 'a', qualified_name: 'a', name: 'a' }),
        makeNode({ id: 'b', qualified_name: 'b', name: 'b' }),
        makeNode({ id: 'c', qualified_name: 'c', name: 'c' }),
      ]);
      // a -> b (CALLS), a -> c (CALLS), b -> c (IMPORTS)
      db.insertEdges([
        makeEdge({ source_id: 'a', target_id: 'b', type: 'CALLS' }),
        makeEdge({ source_id: 'a', target_id: 'c', type: 'CALLS' }),
        makeEdge({ source_id: 'b', target_id: 'c', type: 'IMPORTS' }),
      ]);
    });

    it('counts total degree (both directions)', () => {
      expect(db.getNodeDegree('a', undefined, 'both')).toBe(2); // 2 outbound
      expect(db.getNodeDegree('b', undefined, 'both')).toBe(2); // 1 in + 1 out
      expect(db.getNodeDegree('c', undefined, 'both')).toBe(2); // 2 inbound
    });

    it('counts outbound degree', () => {
      expect(db.getNodeDegree('a', undefined, 'out')).toBe(2);
      expect(db.getNodeDegree('c', undefined, 'out')).toBe(0);
    });

    it('counts inbound degree', () => {
      expect(db.getNodeDegree('a', undefined, 'in')).toBe(0);
      expect(db.getNodeDegree('c', undefined, 'in')).toBe(2);
    });

    it('counts degree filtered by edge type', () => {
      expect(db.getNodeDegree('a', 'CALLS', 'out')).toBe(2);
      expect(db.getNodeDegree('a', 'IMPORTS', 'out')).toBe(0);
      expect(db.getNodeDegree('c', 'CALLS', 'in')).toBe(1);
      expect(db.getNodeDegree('c', 'IMPORTS', 'in')).toBe(1);
    });

    it('getNodesByDegree returns nodes above minimum', () => {
      const result = db.getNodesByDegree('test-project', {
        direction: 'out',
        minDegree: 2,
      });
      expect(result.total).toBe(1);
      expect(result.nodes[0].id).toBe('a');
    });

    it('getNodesByDegree returns nodes below maximum', () => {
      const result = db.getNodesByDegree('test-project', {
        direction: 'out',
        maxDegree: 0,
      });
      expect(result.total).toBe(1);
      expect(result.nodes[0].id).toBe('c');
    });
  });

  // ─── BFS traversal ─────────────────────────────────────────────────

  describe('bfsTraversal', () => {
    beforeEach(() => {
      db.upsertProject(makeProject());
      // Build a chain: a -> b -> c -> d
      db.insertNodes([
        makeNode({ id: 'a', qualified_name: 'a', name: 'a' }),
        makeNode({ id: 'b', qualified_name: 'b', name: 'b' }),
        makeNode({ id: 'c', qualified_name: 'c', name: 'c' }),
        makeNode({ id: 'd', qualified_name: 'd', name: 'd' }),
      ]);
      db.insertEdges([
        makeEdge({ source_id: 'a', target_id: 'b', type: 'CALLS' }),
        makeEdge({ source_id: 'b', target_id: 'c', type: 'CALLS' }),
        makeEdge({ source_id: 'c', target_id: 'd', type: 'CALLS' }),
      ]);
    });

    it('traverses outbound from start node', () => {
      const results = db.bfsTraversal({
        startNodeId: 'a',
        edgeTypes: ['CALLS'],
        direction: 'outbound',
        maxDepth: 10,
      });

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.id)).toEqual(['b', 'c', 'd']);
      expect(results[0].depth).toBe(1);
      expect(results[1].depth).toBe(2);
      expect(results[2].depth).toBe(3);
    });

    it('traverses inbound from end node', () => {
      const results = db.bfsTraversal({
        startNodeId: 'd',
        edgeTypes: ['CALLS'],
        direction: 'inbound',
        maxDepth: 10,
      });

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    });

    it('respects maxDepth', () => {
      const results = db.bfsTraversal({
        startNodeId: 'a',
        edgeTypes: ['CALLS'],
        direction: 'outbound',
        maxDepth: 1,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('b');
    });

    it('respects maxNodes', () => {
      const results = db.bfsTraversal({
        startNodeId: 'a',
        edgeTypes: ['CALLS'],
        direction: 'outbound',
        maxDepth: 10,
        maxNodes: 2,
      });

      expect(results).toHaveLength(2);
    });

    it('returns paths through the graph', () => {
      const results = db.bfsTraversal({
        startNodeId: 'a',
        edgeTypes: ['CALLS'],
        direction: 'outbound',
        maxDepth: 10,
      });

      // The path for node d should include the full chain a>b>c>d
      const dResult = results.find((r) => r.id === 'd');
      expect(dResult).toBeDefined();
      expect(dResult!.path).toEqual(['a', 'b', 'c', 'd']);
    });

    it('does not revisit nodes (cycle prevention)', () => {
      // Add a back-edge: d -> a
      db.insertEdge(makeEdge({ source_id: 'd', target_id: 'a', type: 'CALLS' }));

      const results = db.bfsTraversal({
        startNodeId: 'a',
        edgeTypes: ['CALLS'],
        direction: 'outbound',
        maxDepth: 10,
      });

      // Should still only visit b, c, d (not loop back to a)
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.id)).toEqual(['b', 'c', 'd']);
    });

    it('filters by edge type', () => {
      // Add an IMPORTS edge that should be ignored
      db.insertEdge(makeEdge({ source_id: 'a', target_id: 'd', type: 'IMPORTS' }));

      const results = db.bfsTraversal({
        startNodeId: 'a',
        edgeTypes: ['CALLS'],
        direction: 'outbound',
        maxDepth: 10,
      });

      // Should follow only CALLS edges: a->b->c->d
      // The IMPORTS shortcut a->d should not be followed
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe('b');
    });

    it('returns empty for a node with no matching edges', () => {
      const results = db.bfsTraversal({
        startNodeId: 'd',
        edgeTypes: ['CALLS'],
        direction: 'outbound',
        maxDepth: 10,
      });

      expect(results).toHaveLength(0);
    });
  });

  // ─── File hash tracking ─────────────────────────────────────────────

  describe('file hash tracking', () => {
    it('upserts and retrieves a file hash', () => {
      db.upsertFileHash({
        project: 'proj',
        rel_path: 'src/main.ts',
        content_hash: 'abc123',
        mtime_ns: 1000000,
        size: 2048,
      });

      const result = db.getFileHash('proj', 'src/main.ts');
      expect(result).not.toBeNull();
      expect(result!.content_hash).toBe('abc123');
      expect(result!.size).toBe(2048);
    });

    it('returns null for non-existent file hash', () => {
      expect(db.getFileHash('proj', 'nope.ts')).toBeNull();
    });

    it('updates existing file hash on upsert', () => {
      db.upsertFileHash({
        project: 'proj',
        rel_path: 'src/main.ts',
        content_hash: 'abc123',
        mtime_ns: 1000000,
        size: 2048,
      });
      db.upsertFileHash({
        project: 'proj',
        rel_path: 'src/main.ts',
        content_hash: 'def456',
        mtime_ns: 2000000,
        size: 4096,
      });

      const result = db.getFileHash('proj', 'src/main.ts');
      expect(result!.content_hash).toBe('def456');
      expect(result!.size).toBe(4096);
    });

    it('retrieves all file hashes for a project', () => {
      db.upsertFileHash({
        project: 'proj',
        rel_path: 'a.ts',
        content_hash: 'h1',
        mtime_ns: 1,
        size: 100,
      });
      db.upsertFileHash({
        project: 'proj',
        rel_path: 'b.ts',
        content_hash: 'h2',
        mtime_ns: 2,
        size: 200,
      });
      db.upsertFileHash({
        project: 'other',
        rel_path: 'c.ts',
        content_hash: 'h3',
        mtime_ns: 3,
        size: 300,
      });

      const hashes = db.getAllFileHashes('proj');
      expect(hashes).toHaveLength(2);
    });

    it('deletes all file hashes for a project', () => {
      db.upsertFileHash({
        project: 'proj',
        rel_path: 'a.ts',
        content_hash: 'h1',
        mtime_ns: 1,
        size: 100,
      });
      db.upsertFileHash({
        project: 'proj',
        rel_path: 'b.ts',
        content_hash: 'h2',
        mtime_ns: 2,
        size: 200,
      });

      db.deleteFileHashes('proj');
      expect(db.getAllFileHashes('proj')).toHaveLength(0);
    });

    it('deletes a single file hash', () => {
      db.upsertFileHash({
        project: 'proj',
        rel_path: 'a.ts',
        content_hash: 'h1',
        mtime_ns: 1,
        size: 100,
      });
      db.upsertFileHash({
        project: 'proj',
        rel_path: 'b.ts',
        content_hash: 'h2',
        mtime_ns: 2,
        size: 200,
      });

      db.deleteFileHash('proj', 'a.ts');
      expect(db.getFileHash('proj', 'a.ts')).toBeNull();
      expect(db.getFileHash('proj', 'b.ts')).not.toBeNull();
    });
  });

  // ─── ADR ────────────────────────────────────────────────────────────

  describe('ADR operations', () => {
    beforeEach(() => {
      db.upsertProject(makeProject());
    });

    it('upserts and retrieves an ADR', () => {
      const adr = {
        project: 'test-project',
        summary: JSON.stringify({ PURPOSE: 'Test app' }),
        source_hash: 'hash123',
        created_at: 1000,
        updated_at: 2000,
      };
      db.upsertAdr(adr);

      const result = db.getAdr('test-project');
      expect(result).not.toBeNull();
      expect(result!.summary).toBe(JSON.stringify({ PURPOSE: 'Test app' }));
      expect(result!.source_hash).toBe('hash123');
    });

    it('returns null for non-existent ADR', () => {
      expect(db.getAdr('nope')).toBeNull();
    });

    it('deletes an ADR', () => {
      db.upsertAdr({
        project: 'test-project',
        summary: '{}',
        source_hash: '',
        created_at: 0,
        updated_at: 0,
      });

      db.deleteAdr('test-project');
      expect(db.getAdr('test-project')).toBeNull();
    });
  });

  // ─── Statistics ─────────────────────────────────────────────────────

  describe('statistics', () => {
    beforeEach(() => {
      db.upsertProject(makeProject());
      db.insertNodes([
        makeNode({ id: 'f1', qualified_name: 'f1', name: 'fn1', label: 'Function' }),
        makeNode({ id: 'f2', qualified_name: 'f2', name: 'fn2', label: 'Function' }),
        makeNode({ id: 'c1', qualified_name: 'c1', name: 'cls1', label: 'Class' }),
      ]);
      db.insertEdges([
        makeEdge({ source_id: 'f1', target_id: 'f2', type: 'CALLS' }),
        makeEdge({ source_id: 'c1', target_id: 'f1', type: 'DEFINES' }),
      ]);
    });

    it('counts nodes by project', () => {
      expect(db.getNodeCount('test-project')).toBe(3);
    });

    it('counts edges by project', () => {
      expect(db.getEdgeCount('test-project')).toBe(2);
    });

    it('returns label counts', () => {
      const counts = db.getNodeLabelCounts('test-project');
      expect(counts.Function).toBe(2);
      expect(counts.Class).toBe(1);
    });

    it('returns edge type counts', () => {
      const counts = db.getEdgeTypeCounts('test-project');
      expect(counts.CALLS).toBe(1);
      expect(counts.DEFINES).toBe(1);
    });

    it('returns relationship patterns', () => {
      const patterns = db.getRelationshipPatterns('test-project');
      expect(patterns).toContain('Class -[DEFINES]-> Function');
      expect(patterns).toContain('Function -[CALLS]-> Function');
    });
  });

  // ─── Transaction wrapper ────────────────────────────────────────────

  describe('transaction wrapper', () => {
    beforeEach(() => {
      db.upsertProject(makeProject());
    });

    it('commits on success', () => {
      db.transaction(() => {
        db.insertNode(makeNode({ id: 'tx1', qualified_name: 'tx1', name: 'tx1' }));
        db.insertNode(makeNode({ id: 'tx2', qualified_name: 'tx2', name: 'tx2' }));
      });

      expect(db.getNodeCount('test-project')).toBe(2);
    });

    it('rolls back on error', () => {
      expect(() => {
        db.transaction(() => {
          db.insertNode(makeNode({ id: 'ok', qualified_name: 'ok', name: 'ok' }));
          throw new Error('Deliberate failure');
        });
      }).toThrow('Deliberate failure');

      // Node should not have been persisted
      expect(db.getNode('ok')).toBeNull();
      expect(db.getNodeCount('test-project')).toBe(0);
    });

    it('returns the value from the callback', () => {
      const result = db.transaction(() => {
        db.insertNode(makeNode({ id: 'r1', qualified_name: 'r1', name: 'r1' }));
        return 42;
      });

      expect(result).toBe(42);
    });
  });

  // ─── rawQuery ───────────────────────────────────────────────────────

  describe('rawQuery', () => {
    it('executes read-only SQL', () => {
      db.upsertProject(makeProject());
      db.insertNode(makeNode());

      const rows = db.rawQuery('SELECT name, label FROM nodes WHERE project = ?', ['test-project']);
      expect(rows).toHaveLength(1);
      expect((rows[0] as Record<string, unknown>).name).toBe('parseConfig');
    });
  });

  // ─── Lifecycle ──────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('opens and closes without error', () => {
      const tempDb = new GraphDatabase(':memory:');
      tempDb.upsertProject(makeProject());
      expect(tempDb.getProject('test-project')).not.toBeNull();
      tempDb.close();
    });

    it('creates all expected tables', () => {
      const tables = db.rawQuery(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ) as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name).sort();
      expect(tableNames).toContain('projects');
      expect(tableNames).toContain('nodes');
      expect(tableNames).toContain('edges');
      expect(tableNames).toContain('file_hashes');
      expect(tableNames).toContain('project_summaries');
      expect(tableNames).toContain('nodes_fts');
    });

    it('creates all expected indexes', () => {
      const indexes = db.rawQuery(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      ) as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_nodes_project');
      expect(indexNames).toContain('idx_nodes_label');
      expect(indexNames).toContain('idx_nodes_name');
      expect(indexNames).toContain('idx_nodes_file');
      expect(indexNames).toContain('idx_edges_source');
      expect(indexNames).toContain('idx_edges_target');
      expect(indexNames).toContain('idx_edges_type');
      expect(indexNames).toContain('idx_edges_project');
    });

    it('creates FTS triggers', () => {
      const triggers = db.rawQuery(
        "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name",
      ) as Array<{ name: string }>;

      const triggerNames = triggers.map((t) => t.name);
      expect(triggerNames).toContain('nodes_ai');
      expect(triggerNames).toContain('nodes_ad');
      expect(triggerNames).toContain('nodes_au');
    });

    it('creates graph_metadata table (Package 2 schema)', () => {
      const tables = db.rawQuery(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='graph_metadata'",
      ) as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
    });

    it('projects table has last_opened_at column (Package 2 schema)', () => {
      const cols = db.rawQuery('PRAGMA table_info(projects)') as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'last_opened_at')).toBe(true);
    });

    it('user_version is set to SCHEMA_VERSION after migration', () => {
      const version = db.rawQuery('PRAGMA user_version') as Array<{ user_version: number }>;
      expect(version[0].user_version).toBe(2);
    });
  });

  // ─── Migration: v0 → v2 (chained) ────────────────────────────────────

  describe('migration v0 → v2', () => {
    it('migration is idempotent on a fresh DB (already at v2)', () => {
      // A fresh :memory: DB runs through migration on construction.
      // Creating a second instance should not throw.
      const db2 = new GraphDatabase(':memory:');
      const version = db2.rawQuery('PRAGMA user_version') as Array<{ user_version: number }>;
      expect(version[0].user_version).toBe(2);
      db2.close();
    });
  });

  // ─── Project GC helpers ──────────────────────────────────────────────

  describe('touchProjectOpened / getProjectLastOpened', () => {
    beforeEach(() => {
      db.upsertProject(makeProject());
    });

    it('returns 0 (default) before touch', () => {
      expect(db.getProjectLastOpened('test-project')).toBe(0);
    });

    it('updates last_opened_at after touch', () => {
      const before = Date.now();
      db.touchProjectOpened('test-project');
      const after = Date.now();
      const ts = db.getProjectLastOpened('test-project');
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('returns null for non-existent project', () => {
      expect(db.getProjectLastOpened('nope')).toBeNull();
    });

    it('listAllProjects includes last_opened_at', () => {
      db.upsertProject(makeProject({ name: 'alpha' }));
      db.upsertProject(makeProject({ name: 'beta' }));
      const projects = db.listAllProjects();
      expect(projects.length).toBeGreaterThanOrEqual(2);
      expect(projects[0]).toHaveProperty('name');
      expect(projects[0]).toHaveProperty('last_opened_at');
    });
  });

  // ─── Graph metadata ──────────────────────────────────────────────────

  describe('setGraphMetadata / getGraphMetadata', () => {
    it('stores and retrieves a key-value pair', () => {
      db.setGraphMetadata('catalog_hash', 'abc123');
      expect(db.getGraphMetadata('catalog_hash')).toBe('abc123');
    });

    it('returns null for missing key', () => {
      expect(db.getGraphMetadata('nonexistent')).toBeNull();
    });

    it('overwrites existing value on re-set', () => {
      db.setGraphMetadata('schema_version', '1');
      db.setGraphMetadata('schema_version', '2');
      expect(db.getGraphMetadata('schema_version')).toBe('2');
    });

    it('stores multiple independent keys', () => {
      db.setGraphMetadata('key_a', 'val_a');
      db.setGraphMetadata('key_b', 'val_b');
      expect(db.getGraphMetadata('key_a')).toBe('val_a');
      expect(db.getGraphMetadata('key_b')).toBe('val_b');
    });
  });

  // ─── detectChangesForSession ─────────────────────────────────────────

  describe('detectChangesForSession', () => {
    beforeEach(() => {
      db.upsertProject(makeProject());
      db.insertNodes([
        makeNode({ id: 'fn1', qualified_name: 'fn1', name: 'fn1', file_path: 'src/a.ts' }),
        makeNode({ id: 'fn2', qualified_name: 'fn2', name: 'fn2', file_path: 'src/b.ts' }),
        makeNode({ id: 'fn3', qualified_name: 'fn3', name: 'fn3', file_path: 'src/c.ts' }),
      ]);
      db.insertEdges([
        // fn2 calls fn1 (fn2 is a caller of fn1)
        makeEdge({ source_id: 'fn2', target_id: 'fn1', type: 'CALLS' }),
        // fn3 calls fn2
        makeEdge({ source_id: 'fn3', target_id: 'fn2', type: 'CALLS' }),
      ]);
    });

    it('returns empty result when no files have stored hashes (all changed)', () => {
      // No file_hashes stored → isFileChanged returns true for all
      const result = db.detectChangesForSession('test-project', ['src/a.ts']);
      expect(result.projectName).toBe('test-project');
      expect(result.changedFiles).toContain('src/a.ts');
      expect(result.affectedSymbols.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty affectedSymbols when sessionFiles is empty', () => {
      const result = db.detectChangesForSession('test-project', []);
      expect(result.changedFiles).toHaveLength(0);
      expect(result.affectedSymbols).toHaveLength(0);
      expect(result.blastRadius).toBe(0);
    });

    it('includes transitive callers up to 2 hops', () => {
      // src/a.ts has no stored hash → considered changed
      const result = db.detectChangesForSession('test-project', ['src/a.ts']);
      const ids = result.affectedSymbols.map((s) => s.id);
      // fn1 is in src/a.ts (hop 0), fn2 calls fn1 (hop 1), fn3 calls fn2 (hop 2)
      expect(ids).toContain('fn1');
      expect(ids).toContain('fn2');
      expect(ids).toContain('fn3');
    });

    it('blastRadius equals affectedSymbols count', () => {
      const result = db.detectChangesForSession('test-project', ['src/a.ts']);
      expect(result.blastRadius).toBe(result.affectedSymbols.length);
    });

    it('result shape conforms to ChangedSymbolsForSession', () => {
      const result = db.detectChangesForSession('test-project', ['src/a.ts']);
      for (const sym of result.affectedSymbols) {
        expect(typeof sym.id).toBe('string');
        expect(typeof sym.name).toBe('string');
        expect(typeof sym.label).toBe('string');
        expect(typeof sym.hopDepth).toBe('number');
      }
    });
  });

  // ─── pruneProject ────────────────────────────────────────────────────

  describe('pruneProject', () => {
    beforeEach(() => {
      db.upsertProject(makeProject());
      db.insertNodes([
        makeNode({ id: 'p1', qualified_name: 'p1', name: 'n1' }),
        makeNode({ id: 'p2', qualified_name: 'p2', name: 'n2' }),
      ]);
      db.insertEdge(makeEdge({ source_id: 'p1', target_id: 'p2' }));
      db.upsertFileHash({
        project: 'test-project',
        rel_path: 'src/a.ts',
        content_hash: 'h1',
        mtime_ns: 1,
        size: 100,
      });
    });

    it('deletes the project row and returns node/edge counts', () => {
      const report = db.pruneProject('test-project');
      expect(report.nodes).toBe(2);
      expect(report.edges).toBe(1);
      expect(db.getProject('test-project')).toBeNull();
    });

    it('deletes file hashes for the project', () => {
      db.pruneProject('test-project');
      expect(db.getAllFileHashes('test-project')).toHaveLength(0);
    });

    it('returns zero counts for a project with no data', () => {
      db.upsertProject(makeProject({ name: 'empty-project' }));
      const report = db.pruneProject('empty-project');
      expect(report.nodes).toBe(0);
      expect(report.edges).toBe(0);
    });
  });

  // ─── writeCatalogHash / verifyCatalogHash ────────────────────────────

  describe('writeCatalogHash / verifyCatalogHash', () => {
    beforeEach(() => {
      db.upsertProject(makeProject());
      db.upsertFileHash({
        project: 'test-project',
        rel_path: 'src/a.ts',
        content_hash: 'hash_a',
        mtime_ns: 1,
        size: 100,
      });
      db.upsertFileHash({
        project: 'test-project',
        rel_path: 'src/b.ts',
        content_hash: 'hash_b',
        mtime_ns: 2,
        size: 200,
      });
    });

    it('verifyCatalogHash returns true when no hash is stored (first run)', () => {
      expect(db.verifyCatalogHash('test-project')).toBe(true);
    });

    it('writeCatalogHash stores a non-empty hash string', () => {
      db.writeCatalogHash('test-project');
      const stored = db.getGraphMetadata('catalog_hash:test-project');
      expect(stored).not.toBeNull();
      expect(stored!.length).toBe(32);
    });

    it('verifyCatalogHash returns true immediately after writing', () => {
      db.writeCatalogHash('test-project');
      expect(db.verifyCatalogHash('test-project')).toBe(true);
    });

    it('verifyCatalogHash returns false after file_hashes data changes', () => {
      db.writeCatalogHash('test-project');
      // Mutate the hash data after writing catalog hash
      db.upsertFileHash({
        project: 'test-project',
        rel_path: 'src/a.ts',
        content_hash: 'changed_hash',
        mtime_ns: 1,
        size: 100,
      });
      expect(db.verifyCatalogHash('test-project')).toBe(false);
    });

    it('catalog hash is deterministic (stable sort by rel_path)', () => {
      db.writeCatalogHash('test-project');
      const first = db.getGraphMetadata('catalog_hash:test-project');
      db.writeCatalogHash('test-project');
      const second = db.getGraphMetadata('catalog_hash:test-project');
      expect(first).toBe(second);
    });
  });
});

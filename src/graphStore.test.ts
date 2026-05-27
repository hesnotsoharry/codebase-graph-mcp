import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GraphStore } from './graphStore';
import type { GraphEdge, GraphNode } from './graphTypes';

let tmpDir: string;
let store: GraphStore;

function makeNode(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type: 'function',
    name: id,
    filePath: 'src/test.ts',
    line: 1,
    ...overrides,
  };
}

function makeEdge(source: string, target: string, type: GraphEdge['type'] = 'calls'): GraphEdge {
  return { source, target, type };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-test-'));
  store = new GraphStore(tmpDir);
});

afterEach(() => {
  store.close();
});

describe('GraphStore (SQLite)', () => {
  describe('node CRUD', () => {
    it('adds and retrieves a node', () => {
      const node = makeNode('fn1');
      store.addNode(node);
      expect(store.getNode('fn1')).toEqual(node);
    });

    it('replaces node with same id (INSERT OR REPLACE)', () => {
      store.addNode(makeNode('fn1', { line: 1 }));
      store.addNode(makeNode('fn1', { line: 99 }));
      expect(store.getNode('fn1')?.line).toBe(99);
      expect(store.nodeCount()).toBe(1);
    });

    it('returns undefined for missing node', () => {
      expect(store.getNode('missing')).toBeUndefined();
    });

    it('removeNode deletes node and its edges', () => {
      store.addNode(makeNode('a'));
      store.addNode(makeNode('b'));
      store.addEdge(makeEdge('a', 'b'));
      store.removeNode('a');
      expect(store.getNode('a')).toBeUndefined();
      expect(store.getAllEdges()).toHaveLength(0);
    });

    it('getAllNodes returns all nodes', () => {
      store.addNode(makeNode('a'));
      store.addNode(makeNode('b'));
      expect(store.getAllNodes()).toHaveLength(2);
    });

    it('getNodesByType filters correctly', () => {
      store.addNode(makeNode('fn', { type: 'function' }));
      store.addNode(makeNode('cl', { type: 'class' }));
      expect(store.getNodesByType('function')).toHaveLength(1);
    });

    it('getNodesByFile filters correctly', () => {
      store.addNode(makeNode('a', { filePath: 'a.ts' }));
      store.addNode(makeNode('b', { filePath: 'b.ts' }));
      expect(store.getNodesByFile('a.ts')).toHaveLength(1);
    });
  });

  describe('edge CRUD', () => {
    it('adds and retrieves edges', () => {
      store.addNode(makeNode('a'));
      store.addNode(makeNode('b'));
      store.addEdge(makeEdge('a', 'b'));
      expect(store.getEdgesFrom('a')).toHaveLength(1);
      expect(store.getEdgesTo('b')).toHaveLength(1);
    });

    it('removeEdgesForNode removes edges', () => {
      store.addNode(makeNode('a'));
      store.addNode(makeNode('b'));
      store.addEdge(makeEdge('a', 'b'));
      store.removeEdgesForNode('a');
      expect(store.getAllEdges()).toHaveLength(0);
    });

    it('allows edges with placeholder targets (no FK)', () => {
      store.addEdge(makeEdge('fn1', '__unresolved::foo'));
      expect(store.getAllEdges()).toHaveLength(1);
    });
  });

  describe('replaceAllEdges', () => {
    it('replaces all edges atomically', () => {
      store.addNode(makeNode('a'));
      store.addNode(makeNode('b'));
      store.addNode(makeNode('c'));
      store.addEdge(makeEdge('a', 'b'));
      store.addEdge(makeEdge('b', 'c'));
      expect(store.edgeCount()).toBe(2);

      store.replaceAllEdges([makeEdge('a', 'c', 'imports')]);
      expect(store.edgeCount()).toBe(1);
      const edges = store.getAllEdges();
      expect(edges[0].source).toBe('a');
      expect(edges[0].target).toBe('c');
      expect(edges[0].type).toBe('imports');
    });

    it('handles empty replacement', () => {
      store.addEdge(makeEdge('a', 'b'));
      store.replaceAllEdges([]);
      expect(store.edgeCount()).toBe(0);
    });
  });

  describe('bulk operations', () => {
    it('addBulk inserts nodes and edges in one transaction', () => {
      const nodes = [makeNode('a'), makeNode('b')];
      const edges = [makeEdge('a', 'b')];
      store.addBulk(nodes, edges);
      expect(store.nodeCount()).toBe(2);
      expect(store.edgeCount()).toBe(1);
    });

    it('clearFile removes nodes and edges for a file', () => {
      store.addNode(makeNode('a', { filePath: 'x.ts' }));
      store.addNode(makeNode('b', { filePath: 'y.ts' }));
      store.addEdge(makeEdge('a', 'b'));
      store.clearFile('x.ts');
      expect(store.nodeCount()).toBe(1);
      expect(store.edgeCount()).toBe(0);
    });
  });

  describe('stats', () => {
    it('reports correct counts', () => {
      store.addBulk(
        [makeNode('a', { filePath: 'x.ts' }), makeNode('b', { filePath: 'y.ts' })],
        [makeEdge('a', 'b')],
      );
      expect(store.nodeCount()).toBe(2);
      expect(store.edgeCount()).toBe(1);
      expect(store.fileCount()).toBe(2);
    });
  });

  describe('clear', () => {
    it('removes all nodes and edges', () => {
      store.addBulk([makeNode('a')], [makeEdge('a', 'b')]);
      store.clear();
      expect(store.nodeCount()).toBe(0);
      expect(store.edgeCount()).toBe(0);
    });
  });

  describe('persistence (SQLite — WAL auto-persists)', () => {
    it('save() resolves without error', async () => {
      await expect(store.save()).resolves.toBeUndefined();
    });

    it('load() returns true when data exists', async () => {
      store.addNode(makeNode('a'));
      expect(await store.load()).toBe(true);
    });

    it('load() returns false when empty', async () => {
      expect(await store.load()).toBe(false);
    });

    it('data survives close + reopen', () => {
      store.addNode(makeNode('a', { metadata: { mtime: 123 } }));
      store.addEdge(makeEdge('a', 'b'));
      store.close();

      const store2 = new GraphStore(tmpDir);
      expect(store2.nodeCount()).toBe(1);
      expect(store2.edgeCount()).toBe(1);
      expect(store2.getNode('a')?.metadata).toEqual({ mtime: 123 });
      store2.close();

      // Reassign for afterEach cleanup
      store = new GraphStore(tmpDir);
    });
  });

  describe('metadata roundtrip', () => {
    it('preserves node metadata through JSON serialization', () => {
      const node = makeNode('a', { metadata: { mtime: 12345, custom: 'val' } });
      store.addNode(node);
      expect(store.getNode('a')?.metadata).toEqual({ mtime: 12345, custom: 'val' });
    });

    it('preserves edge metadata', () => {
      store.addEdge({ source: 'a', target: 'b', type: 'calls', metadata: { weight: 3 } });
      const edges = store.getAllEdges();
      expect(edges[0].metadata).toEqual({ weight: 3 });
    });

    it('handles nodes without metadata', () => {
      store.addNode(makeNode('a'));
      const node = store.getNode('a');
      expect(node?.metadata).toBeUndefined();
    });

    it('handles nodes without endLine', () => {
      store.addNode(makeNode('a'));
      const node = store.getNode('a');
      expect(node?.endLine).toBeUndefined();
    });
  });

  describe('transaction', () => {
    it('wraps multiple operations atomically', () => {
      store.transaction(() => {
        store.addNode(makeNode('a'));
        store.addNode(makeNode('b'));
        store.addEdge(makeEdge('a', 'b'));
      });
      expect(store.nodeCount()).toBe(2);
      expect(store.edgeCount()).toBe(1);
    });

    it('rolls back on error', () => {
      store.addNode(makeNode('existing'));
      try {
        store.transaction(() => {
          store.addNode(makeNode('new1'));
          throw new Error('abort');
        });
      } catch {
        // expected
      }
      expect(store.nodeCount()).toBe(1);
      expect(store.getNode('new1')).toBeUndefined();
    });
  });

  describe('creates .ouroboros directory', () => {
    it('graph.db is created on disk', () => {
      store.addNode(makeNode('a'));
      const dbPath = path.join(tmpDir, '.ouroboros', 'graph.db');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled tmpDir path
      expect(fs.existsSync(dbPath)).toBe(true);
    });
  });
});

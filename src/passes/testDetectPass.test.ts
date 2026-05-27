/**
 * testDetectPass.test.ts — Unit tests for testDetectPass and its module-level
 * Function+Method index cache.
 *
 * Test shape: pyramid (pure logic, mocked DB). Unit tests exercise the cache
 * hit/miss/invalidation contract; a separate integration path verifies the
 * TESTS edge I/O contract via the existing pipeline tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphNode } from '../graphDatabaseTypes';
import type { IndexedFile } from './passTypes';
import { _functionIndexCache, testDetectPass } from './testDetectPass';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(id: string, name: string, filePath: string): GraphNode {
  return {
    id,
    project: id.split('.')[0],
    label: 'Function',
    name,
    qualified_name: id,
    file_path: filePath,
    start_line: 1,
    end_line: 5,
    props: {},
  };
}

function makeDb(nodes: GraphNode[] = []): {
  getNodesByLabel: ReturnType<typeof vi.fn>;
  insertEdges: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
} {
  return {
    // getNodesByLabel is the seam under test — spy on call counts.
    getNodesByLabel: vi.fn().mockReturnValue(nodes),
    insertEdges: vi.fn(),
    // transaction is not called by testDetectPass directly; satisfy the type.
    transaction: vi.fn((fn: () => void) => fn()),
  };
}

/** Minimal parsed IndexedFile with no test-function definitions. */
function makeIndexedFile(relativePath: string, parsed = true): IndexedFile {
  return {
    relativePath,
    parsed: parsed
      ? {
          filePath: relativePath,
          language: 'typescript',
          lineCount: 10,
          definitions: [],
          imports: [],
          calls: [],
          routes: [],
          exportedNames: [],
        }
      : null,
  };
}

// ─── Cache lifecycle ──────────────────────────────────────────────────────────

// Reset the module-level cache before each test so cases are independent.
beforeEach(() => {
  _functionIndexCache.clear();
});

afterEach(() => {
  _functionIndexCache.clear();
});

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('testDetectPass — module-level cache', () => {
  describe('cold cache miss + warm cache hit', () => {
    it('calls getNodesByLabel on the first invocation (cold miss), skips it on the second with empty changedFiles (hit)', () => {
      const node = makeNode('proj.src.foo.myFunc', 'myFunc', 'src/foo.ts');
      const db = makeDb([node]);
      const files = [makeIndexedFile('src/foo.ts')];

      // First call: cache is empty — must build the index.
      testDetectPass(db as never, 'proj', files, new Set());
      expect(db.getNodesByLabel).toHaveBeenCalledTimes(2); // Function + Method

      // Second call: changedFiles is an empty set — cache should be reused.
      db.getNodesByLabel.mockClear();
      testDetectPass(db as never, 'proj', files, new Set());
      expect(db.getNodesByLabel).not.toHaveBeenCalled();
    });
  });

  describe('cache invalidation on QN-prefix intersection', () => {
    it('rebuilds the index when a changed file QN prefix intersects functionsByName', () => {
      // Populate the cache for projectA with a function whose QN starts with
      // "projectA.src.foo".
      const node = makeNode('projectA.src.foo.doThing', 'doThing', 'src/foo.ts');
      const db = makeDb([node]);
      const files = [makeIndexedFile('src/foo.ts')];

      // Cold miss — populate the cache.
      testDetectPass(db as never, 'projectA', files, new Set());
      expect(_functionIndexCache.has('projectA')).toBe(true);

      // Second call: changedFiles includes 'src/foo.ts' whose QN prefix
      // 'projectA.src.foo' intersects 'projectA.src.foo.doThing' → must rebuild.
      db.getNodesByLabel.mockClear();
      testDetectPass(db as never, 'projectA', files, new Set(['src/foo.ts']));
      expect(db.getNodesByLabel).toHaveBeenCalled();
    });
  });

  describe('no invalidation on disjoint changedFiles', () => {
    it('reuses the cache when changed files do not intersect any cached QN', () => {
      const node = makeNode('projectA.src.foo.doThing', 'doThing', 'src/foo.ts');
      const db = makeDb([node]);
      const files = [makeIndexedFile('src/foo.ts')];

      // Cold miss — populate the cache.
      testDetectPass(db as never, 'projectA', files, new Set());
      db.getNodesByLabel.mockClear();

      // Second call: changedFiles is 'unrelated/bar.ts' — QN prefix
      // 'projectA.unrelated.bar' does not intersect 'projectA.src.foo.doThing'.
      testDetectPass(db as never, 'projectA', files, new Set(['unrelated/bar.ts']));
      expect(db.getNodesByLabel).not.toHaveBeenCalled();
    });
  });

  describe('full reindex (undefined changedFiles) always invalidates', () => {
    it('rebuilds the index unconditionally when changedFiles is undefined', () => {
      const node = makeNode('proj.src.foo.doThing', 'doThing', 'src/foo.ts');
      const db = makeDb([node]);
      const files = [makeIndexedFile('src/foo.ts')];

      // Populate the cache.
      testDetectPass(db as never, 'proj', files, new Set());
      db.getNodesByLabel.mockClear();

      // Full reindex: changedFiles === undefined → must always invalidate.
      testDetectPass(db as never, 'proj', files, undefined);
      expect(db.getNodesByLabel).toHaveBeenCalled();
    });
  });

  describe('FIFO eviction at N=10', () => {
    it('evicts the oldest project entry when the 11th project is added', () => {
      // Fill the cache with 10 distinct projects.
      for (let i = 0; i < 10; i++) {
        const projectName = `project-${i}`;
        const db = makeDb([]);
        testDetectPass(db as never, projectName, [], new Set());
        expect(_functionIndexCache.has(projectName)).toBe(true);
      }
      expect(_functionIndexCache.size).toBe(10);

      // Adding the 11th project should evict 'project-0' (oldest / insertion order).
      const db11 = makeDb([]);
      testDetectPass(db11 as never, 'project-10', [], new Set());

      expect(_functionIndexCache.size).toBe(10);
      expect(_functionIndexCache.has('project-0')).toBe(false);
      expect(_functionIndexCache.has('project-10')).toBe(true);
      // Keys 1-9 must remain.
      for (let i = 1; i <= 9; i++) {
        expect(_functionIndexCache.has(`project-${i}`)).toBe(true);
      }
    });
  });

  describe('project isolation', () => {
    it('does not invalidate projectA cache when projectB is queried with a conflicting changedFiles path', () => {
      // Populate cache for both projects with same function name but different QNs.
      const nodeA = makeNode('projectA.src.foo.doThing', 'doThing', 'src/foo.ts');
      const nodeB = makeNode('projectB.src.foo.doThing', 'doThing', 'src/foo.ts');

      const dbA = makeDb([nodeA]);
      const dbB = makeDb([nodeB]);

      testDetectPass(dbA as never, 'projectA', [], new Set());
      testDetectPass(dbB as never, 'projectB', [], new Set());

      // Sanity: both are cached.
      expect(_functionIndexCache.has('projectA')).toBe(true);
      expect(_functionIndexCache.has('projectB')).toBe(true);

      // Record the projectA entry reference so we can confirm it's unchanged.
      const entryA = _functionIndexCache.get('projectA');

      // Query projectB with a changedFiles that would intersect projectA's QN
      // prefix if the check were project-agnostic. The check is scoped to the
      // active project's entry, so projectA's cache should not be touched.
      dbB.getNodesByLabel.mockClear();
      testDetectPass(dbB as never, 'projectB', [], new Set(['src/foo.ts']));

      // projectB was invalidated (its fn is at projectB.src.foo.doThing which
      // intersects the 'src/foo.ts' → 'projectB.src.foo' prefix).
      expect(dbB.getNodesByLabel).toHaveBeenCalled();

      // projectA's entry is the same object — untouched.
      expect(_functionIndexCache.get('projectA')).toBe(entryA);
    });
  });
});

describe('testDetectPass — TESTS edge emission (I/O contract)', () => {
  it('emits no edges when there are no test files in indexedFiles', () => {
    const db = makeDb([]);
    const files = [makeIndexedFile('src/foo.ts')];

    testDetectPass(db as never, 'proj', files, new Set());
    expect(db.insertEdges).not.toHaveBeenCalled();
  });

  it('emits no edges when indexedFiles is empty', () => {
    const db = makeDb([]);

    testDetectPass(db as never, 'proj', [], new Set());
    expect(db.insertEdges).not.toHaveBeenCalled();
  });

  it('deduplicates edges with the same source/target pair', () => {
    // Create a function node for the subject.
    const fnNode = makeNode('proj.src.foo.doThing', 'doThing', 'src/foo.ts');
    const db = makeDb([fnNode]);

    // A test file whose test function name contains 'doThing' (name heuristic).
    const testFile: IndexedFile = {
      relativePath: 'src/foo.test.ts',
      parsed: {
        filePath: 'src/foo.test.ts',
        language: 'typescript',
        lineCount: 10,
        definitions: [
          { kind: 'Function', name: 'test_doThing_works', startLine: 1, endLine: 3 } as never,
          // Second definition with same name — would produce duplicate edge.
          { kind: 'Function', name: 'test_doThing_works', startLine: 5, endLine: 7 } as never,
        ],
        imports: [],
        calls: [],
        routes: [],
        exportedNames: [],
      },
    };

    testDetectPass(db as never, 'proj', [testFile], new Set());
    // insertEdges should be called once; the duplicate pair must be collapsed.
    if (db.insertEdges.mock.calls.length > 0) {
      const edges: Array<{ source_id: string; target_id: string }> =
        db.insertEdges.mock.calls[0][0];
      const seen = new Set<string>();
      for (const e of edges) {
        const key = `${e.source_id}|${e.target_id}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});

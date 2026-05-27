import { describe, expect, it, vi } from 'vitest';

import type { SessionDbAccessor } from './graphDatabaseSession';
import {
  collectInboundNeighbours,
  detectChangesForSession,
  expandCallers,
  isFileChanged,
} from './graphDatabaseSession';

function makeDb(overrides: Partial<SessionDbAccessor> = {}): SessionDbAccessor {
  return {
    getFileHash: vi.fn().mockReturnValue(null),
    getNodesByFile: vi.fn().mockReturnValue([]),
    getNode: vi.fn().mockReturnValue(null),
    getInboundEdges: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe('graphDatabaseSession', () => {
  describe('isFileChanged', () => {
    it('returns true when no stored hash exists', () => {
      const db = makeDb({ getFileHash: vi.fn().mockReturnValue(null) });
      expect(isFileChanged(db, 'proj', 'foo.ts')).toBe(true);
    });

    it('returns true when statSync throws', () => {
      const db = makeDb({
        getFileHash: vi.fn().mockReturnValue({
          project: 'proj',
          rel_path: 'foo.ts',
          content_hash: 'abc',
          mtime_ns: 9999999999999,
          size: 100,
        }),
      });
      // statSync will throw for a non-existent path
      expect(isFileChanged(db, 'proj', '__nonexistent_path_xyz__.ts')).toBe(true);
    });
  });

  describe('collectInboundNeighbours', () => {
    it('adds source_ids from inbound edges to the set', () => {
      const db = makeDb({
        getInboundEdges: vi.fn().mockReturnValue([
          { id: 1, project: 'p', source_id: 'A', target_id: 'B', type: 'CALLS', props: {} },
          { id: 2, project: 'p', source_id: 'C', target_id: 'B', type: 'CALLS', props: {} },
        ]),
      });
      const next = new Set<string>();
      collectInboundNeighbours(db, 'B', next);
      expect([...next].sort()).toEqual(['A', 'C']);
    });

    it('does nothing when there are no inbound edges', () => {
      const db = makeDb({ getInboundEdges: vi.fn().mockReturnValue([]) });
      const next = new Set<string>();
      collectInboundNeighbours(db, 'X', next);
      expect(next.size).toBe(0);
    });
  });

  describe('expandCallers', () => {
    it('returns empty map when seeds are empty', () => {
      const db = makeDb();
      const result = expandCallers(db, new Set(), 2);
      expect(result.size).toBe(0);
    });

    it('returns symbols for seed nodes (hop 0)', () => {
      const db = makeDb({
        getNode: vi.fn().mockReturnValue({
          id: 'sym1',
          project: 'p',
          label: 'Function',
          name: 'myFn',
          qualified_name: 'myFn',
          file_path: 'foo.ts',
          start_line: 1,
          end_line: 10,
          props: {},
        }),
        getInboundEdges: vi.fn().mockReturnValue([]),
      });
      const result = expandCallers(db, new Set(['sym1']), 1);
      expect(result.has('sym1')).toBe(true);
      expect(result.get('sym1')?.hopDepth).toBe(0);
    });
  });

  describe('detectChangesForSession', () => {
    it('returns empty result when no files are changed', () => {
      const db = makeDb({
        // Return a hash with mtime far in the future so file appears unchanged
        // but statSync will throw => isFileChanged returns true unless we override
        // Instead: return no session files
      });
      const result = detectChangesForSession(db, 'proj', []);
      expect(result.changedFiles).toEqual([]);
      expect(result.affectedSymbols).toEqual([]);
      expect(result.blastRadius).toBe(0);
    });

    it('populates changedFiles when files have no stored hash', () => {
      const db = makeDb({
        getFileHash: vi.fn().mockReturnValue(null),
        getNodesByFile: vi.fn().mockReturnValue([]),
      });
      const result = detectChangesForSession(db, 'proj', ['a.ts', 'b.ts']);
      expect(result.changedFiles).toEqual(['a.ts', 'b.ts']);
      expect(result.projectName).toBe('proj');
    });
  });
});

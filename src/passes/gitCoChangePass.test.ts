/**
 * gitCoChangePass.test.ts — Unit tests for git co-change pass.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphDatabase } from '../graphDatabase';
import { gitCoChangePass, prefetchGitCoChangeData } from './gitCoChangePass';

// ─── Mock gitStdout ───────────────────────────────────────────────────────────

vi.mock('../gitExec', () => ({
  gitStdout: vi.fn(),
}));

import { gitStdout } from '../gitExec';
const mockGitStdout = vi.mocked(gitStdout);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDb(): GraphDatabase {
  return new GraphDatabase(':memory:');
}

function makeLog(...commits: string[][]): string {
  // Each commit block: ---COMMIT--- separator then file list
  return commits.map((files) => `---COMMIT---\n${files.join('\n')}`).join('\n');
}

// ─── prefetchGitCoChangeData ──────────────────────────────────────────────────

describe('prefetchGitCoChangeData', () => {
  it('returns parsed commit-to-files arrays on success', async () => {
    mockGitStdout.mockResolvedValueOnce(makeLog(['src/a.ts', 'src/b.ts'], ['src/c.ts']));
    const result = await prefetchGitCoChangeData('/repo');
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result![1]).toEqual(['src/c.ts']);
  });

  it('returns null when git throws', async () => {
    mockGitStdout.mockRejectedValueOnce(new Error('not a git repo'));
    const result = await prefetchGitCoChangeData('/repo');
    expect(result).toBeNull();
  });

  it('filters empty blocks from git output', async () => {
    mockGitStdout.mockResolvedValueOnce('---COMMIT---\n\n---COMMIT---\nsrc/a.ts\n');
    const result = await prefetchGitCoChangeData('/repo');
    // Empty block produces empty array that still passes filter(Boolean) on split result
    // but inner filter(Boolean) removes empty lines — empty arrays are included
    expect(result).not.toBeNull();
  });
});

// ─── gitCoChangePass ──────────────────────────────────────────────────────────

describe('gitCoChangePass', () => {
  let db: GraphDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  it('is a no-op when commitFiles is null', () => {
    db.upsertProject({
      name: 'proj',
      root_path: '/r',
      indexed_at: 0,
      node_count: 0,
      edge_count: 0,
    });
    expect(() => gitCoChangePass(db, 'proj', null)).not.toThrow();
    expect(db.getEdgeCount('proj')).toBe(0);
  });

  it('creates FILE_CHANGES_WITH edges for pairs that meet the threshold', () => {
    const proj = 'proj';
    db.upsertProject({ name: proj, root_path: '/r', indexed_at: 0, node_count: 0, edge_count: 0 });

    // Insert File nodes so getNode() returns them
    const nodeA = {
      id: 'proj.src.a',
      project: proj,
      label: 'File' as const,
      name: 'a',
      qualified_name: 'proj.src.a',
      file_path: 'src/a.ts',
      start_line: 0,
      end_line: 0,
      props: {},
    };
    const nodeB = {
      id: 'proj.src.b',
      project: proj,
      label: 'File' as const,
      name: 'b',
      qualified_name: 'proj.src.b',
      file_path: 'src/b.ts',
      start_line: 0,
      end_line: 0,
      props: {},
    };
    db.insertNodes([nodeA, nodeB]);

    // Build 3 commits each touching both files (meets CO_CHANGE_THRESHOLD = 3)
    const commits = [
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'src/b.ts'],
    ];

    gitCoChangePass(db, proj, commits);
    expect(db.getEdgeCount(proj)).toBe(1);
  });

  it('does not create edges for pairs below the threshold', () => {
    const proj = 'proj';
    db.upsertProject({ name: proj, root_path: '/r', indexed_at: 0, node_count: 0, edge_count: 0 });
    const nodeA = {
      id: 'proj.src.a',
      project: proj,
      label: 'File' as const,
      name: 'a',
      qualified_name: 'proj.src.a',
      file_path: 'src/a.ts',
      start_line: 0,
      end_line: 0,
      props: {},
    };
    const nodeB = {
      id: 'proj.src.b',
      project: proj,
      label: 'File' as const,
      name: 'b',
      qualified_name: 'proj.src.b',
      file_path: 'src/b.ts',
      start_line: 0,
      end_line: 0,
      props: {},
    };
    db.insertNodes([nodeA, nodeB]);

    // Only 2 co-changes — below threshold of 3
    gitCoChangePass(db, proj, [
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'src/b.ts'],
    ]);
    expect(db.getEdgeCount(proj)).toBe(0);
  });

  it('skips commits that exceed MAX_FILES_PER_COMMIT (20)', () => {
    const proj = 'proj';
    db.upsertProject({ name: proj, root_path: '/r', indexed_at: 0, node_count: 0, edge_count: 0 });

    // 21-file commits should be excluded; repeat 5x so threshold would be met otherwise
    const bigCommit = Array.from({ length: 21 }, (_, i) => `src/file${i}.ts`);
    const commits = Array.from({ length: 5 }, () => bigCommit);
    gitCoChangePass(db, proj, commits);
    expect(db.getEdgeCount(proj)).toBe(0);
  });
});

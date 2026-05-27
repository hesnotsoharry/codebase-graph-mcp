/**
 * graphGc.test.ts — Tests for the GC pruner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphDatabase } from './graphDatabase';
import { pruneExpiredProjects, purgeSkippedNodes } from './graphGc';
import type { IndexingWorkerClient } from './indexingWorkerClient';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedProject(db: GraphDatabase, name: string, lastOpenedAt: number): void {
  db.upsertProject({
    name,
    root_path: `/projects/${name}`,
    indexed_at: Date.now(),
    node_count: 0,
    edge_count: 0,
  });
  if (lastOpenedAt > 0) db.touchProjectOpened(name);
  // Override last_opened_at directly since touchProjectOpened sets it to Date.now()
  db['db'].prepare('UPDATE projects SET last_opened_at = ? WHERE name = ?').run(lastOpenedAt, name);
}

const DAY_MS = 86_400_000;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('pruneExpiredProjects', () => {
  let db: GraphDatabase;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('returns zero counts when there are no projects', () => {
    const report = pruneExpiredProjects(db, 90);
    expect(report.prunedCount).toBe(0);
    expect(report.keptCount).toBe(0);
    expect(report.prunedProjects).toEqual([]);
  });

  it('prunes a project that is strictly older than the threshold', () => {
    const oldTimestamp = Date.now() - 100 * DAY_MS; // 100 days ago
    seedProject(db, 'old-project', oldTimestamp);

    const report = pruneExpiredProjects(db, 90);

    expect(report.prunedCount).toBe(1);
    expect(report.prunedProjects).toContain('old-project');
    expect(db.getProject('old-project')).toBeNull();
  });

  it('keeps a project that is within the threshold', () => {
    const recentTimestamp = Date.now() - 30 * DAY_MS; // 30 days ago
    seedProject(db, 'fresh-project', recentTimestamp);

    const report = pruneExpiredProjects(db, 90);

    expect(report.prunedCount).toBe(0);
    expect(report.keptCount).toBe(1);
    expect(db.getProject('fresh-project')).not.toBeNull();
  });

  it('keeps a project whose last_opened_at is exactly at the threshold boundary', () => {
    // Freeze time so Date.now() at seed and Date.now() inside pruneExpiredProjects
    // are identical; otherwise the few-ms gap pushes cutoff past the seed timestamp.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T00:00:00Z'));
    try {
      const boundaryTimestamp = Date.now() - 90 * DAY_MS;
      seedProject(db, 'boundary-project', boundaryTimestamp);

      const report = pruneExpiredProjects(db, 90);

      // >= cutoff means kept (boundary is not strictly older)
      expect(report.keptCount).toBe(1);
      expect(report.prunedCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves projects with last_opened_at === 0 (never opened under new schema)', () => {
    db.upsertProject({
      name: 'unseeded',
      root_path: '/projects/unseeded',
      indexed_at: Date.now(),
      node_count: 0,
      edge_count: 0,
    });
    // last_opened_at defaults to 0

    const report = pruneExpiredProjects(db, 90);

    expect(report.keptCount).toBe(1);
    expect(report.prunedCount).toBe(0);
    expect(db.getProject('unseeded')).not.toBeNull();
  });

  it('handles a mix of expired, fresh, and unseeded projects correctly', () => {
    seedProject(db, 'expired-a', Date.now() - 120 * DAY_MS);
    seedProject(db, 'expired-b', Date.now() - 200 * DAY_MS);
    seedProject(db, 'fresh', Date.now() - 10 * DAY_MS);
    db.upsertProject({
      name: 'never-opened',
      root_path: '/p/n',
      indexed_at: Date.now(),
      node_count: 0,
      edge_count: 0,
    });

    const report = pruneExpiredProjects(db, 90);

    expect(report.prunedCount).toBe(2);
    expect(report.keptCount).toBe(2);
    expect(report.prunedProjects).toContain('expired-a');
    expect(report.prunedProjects).toContain('expired-b');
    expect(db.getProject('fresh')).not.toBeNull();
    expect(db.getProject('never-opened')).not.toBeNull();
  });
});

// ─── purgeSkippedNodes ────────────────────────────────────────────────────────

describe('purgeSkippedNodes', () => {
  let db: GraphDatabase;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.upsertProject({
      name: 'proj',
      root_path: '/repo',
      indexed_at: Date.now(),
      node_count: 0,
      edge_count: 0,
    });
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function insertNode(id: string, filePath: string): void {
    db.insertNode({
      id,
      project: 'proj',
      label: 'Function',
      name: id,
      qualified_name: `proj::${id}`,
      file_path: filePath,
      start_line: 1,
      end_line: 5,
      props: {},
    });
  }

  it('evicts nodes whose file_path contains .claude/worktrees/', () => {
    insertNode('stale1', '/repo/.claude/worktrees/abc/src/foo.ts');
    insertNode('clean1', '/repo/src/bar.ts');

    const report = purgeSkippedNodes(db);

    expect(report.alreadyDone).toBe(false);
    expect(report.totalPurged).toBe(1);
    expect(db.getNode('stale1')).toBeNull();
    expect(db.getNode('clean1')).not.toBeNull();
  });

  it('is idempotent — second call returns alreadyDone=true without touching DB', () => {
    insertNode('node-a', '/repo/.claude/worktrees/def/x.ts');

    purgeSkippedNodes(db); // first pass — purges
    insertNode('node-b', '/repo/.claude/worktrees/def/y.ts'); // re-insert after pass

    const report = purgeSkippedNodes(db); // second pass — should be no-op

    expect(report.alreadyDone).toBe(true);
    expect(report.totalPurged).toBe(0);
    // node-b still exists because the second pass was skipped
    expect(db.getNode('node-b')).not.toBeNull();
  });

  it('preserves all nodes when no worktree paths exist', () => {
    insertNode('f1', '/repo/src/a.ts');
    insertNode('f2', '/repo/lib/b.ts');

    const report = purgeSkippedNodes(db);

    expect(report.totalPurged).toBe(0);
    expect(db.getNode('f1')).not.toBeNull();
    expect(db.getNode('f2')).not.toBeNull();
  });

  it('handles multiple projects in a single pass', () => {
    db.upsertProject({
      name: 'other',
      root_path: '/other',
      indexed_at: Date.now(),
      node_count: 0,
      edge_count: 0,
    });
    db.insertNode({
      id: 'w1',
      project: 'proj',
      label: 'Function',
      name: 'w1',
      qualified_name: 'proj::w1',
      file_path: '/proj/.claude/worktrees/x/a.ts',
      start_line: 1,
      end_line: 1,
      props: {},
    });
    db.insertNode({
      id: 'w2',
      project: 'other',
      label: 'Function',
      name: 'w2',
      qualified_name: 'other::w2',
      file_path: '/other/.claude/worktrees/y/b.ts',
      start_line: 1,
      end_line: 1,
      props: {},
    });

    const report = purgeSkippedNodes(db);

    expect(report.totalPurged).toBe(2);
    expect(report.projectsScanned).toBe(2);
  });
});

// ─── GC ↔ indexing worker mutual exclusion ────────────────────────────────────

describe('pruneExpiredProjects with indexing worker mutex', () => {
  let db: GraphDatabase;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('defers GC when indexing is in progress', () => {
    const oldTimestamp = Date.now() - 100 * 86_400_000; // 100 days ago
    db.upsertProject({
      name: 'old-project',
      root_path: '/projects/old-project',
      indexed_at: Date.now(),
      node_count: 5,
      edge_count: 3,
    });
    db['db'].prepare('UPDATE projects SET last_opened_at = ? WHERE name = ?').run(oldTimestamp, 'old-project');

    // Pass a stub worker client reporting indexing is in progress
    const mockWorker = { isIndexingInProgress: () => true } as Pick<IndexingWorkerClient, 'isIndexingInProgress'> as IndexingWorkerClient;

    const report = pruneExpiredProjects(db, 90, mockWorker);

    // Should not prune anything while indexing is in progress
    expect(report.prunedCount).toBe(0);
    expect(report.keptCount).toBe(0);
    expect(report.prunedProjects).toEqual([]);
    // Project should still exist
    expect(db.getProject('old-project')).not.toBeNull();
  });

  it('proceeds with GC when indexing is not in progress', () => {
    const oldTimestamp = Date.now() - 100 * 86_400_000; // 100 days ago
    db.upsertProject({
      name: 'old-project',
      root_path: '/projects/old-project',
      indexed_at: Date.now(),
      node_count: 5,
      edge_count: 3,
    });
    db['db'].prepare('UPDATE projects SET last_opened_at = ? WHERE name = ?').run(oldTimestamp, 'old-project');

    // Pass a stub worker client reporting indexing is not in progress
    const mockWorker = { isIndexingInProgress: () => false } as Pick<IndexingWorkerClient, 'isIndexingInProgress'> as IndexingWorkerClient;

    const report = pruneExpiredProjects(db, 90, mockWorker);

    // Should prune the old project
    expect(report.prunedCount).toBe(1);
    expect(report.prunedProjects).toContain('old-project');
    expect(db.getProject('old-project')).toBeNull();
  });
});

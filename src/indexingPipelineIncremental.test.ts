/**
 * indexingPipelineIncremental.test.ts — Smoke tests for discoverFiles and filterChangedFiles.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  discoverFiles,
  filterChangedFiles,
  resolveIncrementalFiles,
} from './indexingPipelineIncremental';
import type { DiscoveredFile } from './indexingPipelineTypes';

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock hashFileContent so filterChangedFiles tests don't require real files on disk.
vi.mock('./indexingPipelineSupport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./indexingPipelineSupport')>();
  return {
    ...actual,
    hashFileContent: vi.fn().mockResolvedValue('mockedhash000000000000000000000000'),
  };
});

// ─── discoverFiles ────────────────────────────────────────────────────────────

describe('discoverFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idx-incr-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns discovered .ts files in the project root', async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture
    await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export const x = 1', 'utf-8');
    const files = await discoverFiles(tmpDir, { projectRoot: tmpDir });
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.relativePath === 'index.ts')).toBe(true);
  });

  it('returns an empty array for an empty directory', async () => {
    const files = await discoverFiles(tmpDir, { projectRoot: tmpDir });
    expect(files).toEqual([]);
  });

  it('caps results at maxFiles — stops recursing into subdirectories past cap', async () => {
    // Create two subdirectories each with one file.
    // With maxFiles=1, the second subdir should not be visited.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture
    await fs.mkdir(path.join(tmpDir, 'a'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture
    await fs.mkdir(path.join(tmpDir, 'b'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture
    await fs.writeFile(path.join(tmpDir, 'a', 'file1.ts'), 'export const a = 1', 'utf-8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture
    await fs.writeFile(path.join(tmpDir, 'b', 'file2.ts'), 'export const b = 2', 'utf-8');
    const files = await discoverFiles(tmpDir, { projectRoot: tmpDir, maxFiles: 1 });
    // With cap=1, second subdir is skipped via the early-return guard.
    expect(files.length).toBeLessThanOrEqual(1);
  });

  it('sets absolutePath, relativePath, sizeBytes, and mtimeMs on each file', async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture
    await fs.writeFile(path.join(tmpDir, 'hello.ts'), 'const z = 0', 'utf-8');
    const files = await discoverFiles(tmpDir, { projectRoot: tmpDir });
    const f = files.find((x) => x.relativePath === 'hello.ts');
    expect(f).toBeDefined();
    expect(f!.absolutePath).toContain('hello.ts');
    expect(f!.sizeBytes).toBeGreaterThan(0);
    expect(f!.mtimeMs).toBeGreaterThan(0);
  });
});

// ─── filterChangedFiles ───────────────────────────────────────────────────────

function makeFile(relativePath: string, override: Partial<DiscoveredFile> = {}): DiscoveredFile {
  return {
    absolutePath: `/tmp/${relativePath}`,
    relativePath,
    extension: relativePath.split('.').pop() ?? 'ts',
    sizeBytes: 100,
    mtimeMs: 1_000_000,
    ...override,
  };
}

describe('filterChangedFiles', () => {
  it('classifies all files as changed when the db has no records', async () => {
    const db = {
      getFileHash: vi.fn().mockReturnValue(null),
      upsertFileHash: vi.fn(),
    } as unknown as import('./graphDatabase').GraphDatabase;

    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')];
    const result = await filterChangedFiles(db, 'proj', files);
    expect(result.changed).toHaveLength(2);
    expect(result.unchanged).toHaveLength(0);
  });

  it('classifies file as unchanged-stat when mtime and size match', async () => {
    const file = makeFile('src/a.ts', { sizeBytes: 200, mtimeMs: 2_000_000 });
    const db = {
      getFileHash: vi.fn().mockReturnValue({
        mtime_ns: Math.floor(file.mtimeMs * 1e6),
        size: file.sizeBytes,
        content_hash: 'abc123',
      }),
      upsertFileHash: vi.fn(),
    } as unknown as import('./graphDatabase').GraphDatabase;

    const result = await filterChangedFiles(db, 'proj', [file]);
    expect(result.unchanged).toContain('src/a.ts');
    expect(result.changed).toHaveLength(0);
    // stat match — no hash computed, no upsert needed
    expect(db.upsertFileHash).not.toHaveBeenCalled();
  });

  it('returns changed files that have no prior hash record', async () => {
    const db = {
      getFileHash: vi.fn().mockReturnValue(null),
      upsertFileHash: vi.fn(),
    } as unknown as import('./graphDatabase').GraphDatabase;

    const result = await filterChangedFiles(db, 'proj', [makeFile('src/new.ts')]);
    expect(result.changed.map((f) => f.relativePath)).toContain('src/new.ts');
  });
});

// ─── resolveIncrementalFiles ─────────────────────────────────────────────────

describe('resolveIncrementalFiles', () => {
  it('returns filesToProcess=[] and isIncrementalRun=true when no files changed', async () => {
    const allFiles = [makeFile('src/a.ts'), makeFile('src/b.ts'), makeFile('src/c.ts')];

    const db = {
      getFileHash: vi.fn().mockReturnValue({
        mtime_ns: Math.floor(makeFile('src/a.ts').mtimeMs * 1e6),
        size: makeFile('src/a.ts').sizeBytes,
        content_hash: 'abc123',
      }),
      upsertFileHash: vi.fn(),
    } as unknown as import('./graphDatabase').GraphDatabase;

    const deleteNodesFn = vi.fn();
    const pruneDeletedFn = vi.fn();

    const result = await resolveIncrementalFiles({
      db,
      projectName: 'proj',
      allFiles,
      pruneDeleted: pruneDeletedFn,
      deleteNodes: deleteNodesFn,
    });

    expect(result.filesToProcess).toHaveLength(0);
    expect(result.isIncrementalRun).toBe(true);
    // Fast-path: deleteNodes not called (nothing changed), but pruneDeleted IS
    // called so deletion-only events (file removed, nothing else modified) are
    // handled correctly — fixes the bug where deleted nodes persisted forever.
    expect(deleteNodesFn).not.toHaveBeenCalled();
    expect(pruneDeletedFn).toHaveBeenCalledWith(allFiles);
  });

  it('prunes deleted file nodes when the only change is a deletion (deletion-only event)', async () => {
    // Simulate: full index previously ran with src/a.ts and src/b.ts.
    // src/b.ts has since been deleted; discoverFiles now only returns src/a.ts.
    const allFilesAfterDeletion = [makeFile('src/a.ts')];

    const db = {
      // Both files match their stored hash (nothing content-changed)
      getFileHash: vi.fn().mockReturnValue({
        mtime_ns: Math.floor(makeFile('src/a.ts').mtimeMs * 1e6),
        size: makeFile('src/a.ts').sizeBytes,
        content_hash: 'abc123',
      }),
      upsertFileHash: vi.fn(),
    } as unknown as import('./graphDatabase').GraphDatabase;

    const deleteNodesFn = vi.fn();
    const pruneDeletedFn = vi.fn();

    const result = await resolveIncrementalFiles({
      db,
      projectName: 'proj',
      allFiles: allFilesAfterDeletion,
      pruneDeleted: pruneDeletedFn,
      deleteNodes: deleteNodesFn,
    });

    // No content changed — filesToProcess is empty and this is an incremental run
    expect(result.filesToProcess).toHaveLength(0);
    expect(result.isIncrementalRun).toBe(true);
    // pruneDeleted MUST be called with the current disk state so src/b.ts nodes
    // are removed from the graph (was the deletion-only bug before the fix)
    expect(pruneDeletedFn).toHaveBeenCalledWith(allFilesAfterDeletion);
    // deleteNodes is for content-changed files only — not called in a deletion-only event
    expect(deleteNodesFn).not.toHaveBeenCalled();
  });

  it('calls deleteNodes for each changed file', async () => {
    const allFiles = [makeFile('src/a.ts'), makeFile('src/b.ts')];

    const db = {
      getFileHash: vi.fn((_projectName, path) => {
        // First file is unchanged, second is missing from DB (changed)
        if (path === 'src/a.ts') {
          return {
            mtime_ns: Math.floor(allFiles[0]!.mtimeMs * 1e6),
            size: allFiles[0]!.sizeBytes,
            content_hash: 'abc123',
          };
        }
        return null;
      }),
      upsertFileHash: vi.fn(),
    } as unknown as import('./graphDatabase').GraphDatabase;

    const deleteNodesFn = vi.fn();
    const pruneDeletedFn = vi.fn();

    const result = await resolveIncrementalFiles({
      db,
      projectName: 'proj',
      allFiles,
      pruneDeleted: pruneDeletedFn,
      deleteNodes: deleteNodesFn,
    });

    expect(result.filesToProcess).toHaveLength(1);
    expect(result.filesToProcess[0]!.relativePath).toBe('src/b.ts');
    expect(deleteNodesFn).toHaveBeenCalledWith('src/b.ts');
    expect(pruneDeletedFn).toHaveBeenCalled();
  });

  it('classifies only the subset when changedPaths is provided and non-empty', async () => {
    const fileA = makeFile('src/a.ts');
    const fileB = makeFile('src/b.ts');
    const fileC = makeFile('src/c.ts');
    const allFiles = [fileA, fileB, fileC];

    const changedPaths = [fileB.absolutePath]; // Only one file in the hint

    const db = {
      getFileHash: vi.fn().mockReturnValue(null),
      upsertFileHash: vi.fn(),
    } as unknown as import('./graphDatabase').GraphDatabase;

    const deleteNodesFn = vi.fn();
    const pruneDeletedFn = vi.fn();

    const result = await resolveIncrementalFiles({
      db,
      projectName: 'proj',
      allFiles,
      changedPaths,
      pruneDeleted: pruneDeletedFn,
      deleteNodes: deleteNodesFn,
    });

    expect(result.filesToProcess).toHaveLength(1);
    expect(result.filesToProcess[0]!.relativePath).toBe('src/b.ts');
    expect(deleteNodesFn).toHaveBeenCalledWith('src/b.ts');
  });

  it('treats empty changedPaths array as "no hint" and classifies all files', async () => {
    const allFiles = [makeFile('src/a.ts'), makeFile('src/b.ts')];

    const db = {
      getFileHash: vi.fn().mockReturnValue(null),
      upsertFileHash: vi.fn(),
    } as unknown as import('./graphDatabase').GraphDatabase;

    const deleteNodesFn = vi.fn();
    const pruneDeletedFn = vi.fn();

    const result = await resolveIncrementalFiles({
      db,
      projectName: 'proj',
      allFiles,
      changedPaths: [], // Empty hint — should fall through to full classify
      pruneDeleted: pruneDeletedFn,
      deleteNodes: deleteNodesFn,
    });

    // All files are new (no prior hash)
    expect(result.filesToProcess).toHaveLength(2);
    expect(result.filesToProcess.map((f) => f.relativePath)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('calls pruneDeleted with allFiles', async () => {
    const allFiles = [makeFile('src/a.ts'), makeFile('src/b.ts')];

    const db = {
      getFileHash: vi.fn().mockReturnValue(null),
      upsertFileHash: vi.fn(),
    } as unknown as import('./graphDatabase').GraphDatabase;

    const deleteNodesFn = vi.fn();
    const pruneDeletedFn = vi.fn();

    await resolveIncrementalFiles({
      db,
      projectName: 'proj',
      allFiles,
      pruneDeleted: pruneDeletedFn,
      deleteNodes: deleteNodesFn,
    });

    // pruneDeleted is called with allFiles when there are changed files
    expect(pruneDeletedFn).toHaveBeenCalledWith(allFiles);
  });

  it('detects isIncrementalRun as true when not all files are in filesToProcess', async () => {
    const allFiles = [makeFile('src/a.ts'), makeFile('src/b.ts'), makeFile('src/c.ts')];

    const db = {
      getFileHash: vi.fn((_projectName, path) => {
        // Only b.ts is changed; a.ts and c.ts are unchanged
        if (path === 'src/b.ts') return null;
        return {
          mtime_ns: Math.floor(makeFile('src/a.ts').mtimeMs * 1e6),
          size: makeFile('src/a.ts').sizeBytes,
          content_hash: 'abc123',
        };
      }),
      upsertFileHash: vi.fn(),
    } as unknown as import('./graphDatabase').GraphDatabase;

    const result = await resolveIncrementalFiles({
      db,
      projectName: 'proj',
      allFiles,
      pruneDeleted: vi.fn(),
      deleteNodes: vi.fn(),
    });

    expect(result.isIncrementalRun).toBe(true);
  });

  it('detects isIncrementalRun as false when all files must be reprocessed', async () => {
    const allFiles = [makeFile('src/a.ts'), makeFile('src/b.ts')];

    const db = {
      getFileHash: vi.fn().mockReturnValue(null), // All files are new
      upsertFileHash: vi.fn(),
    } as unknown as import('./graphDatabase').GraphDatabase;

    const result = await resolveIncrementalFiles({
      db,
      projectName: 'proj',
      allFiles,
      pruneDeleted: vi.fn(),
      deleteNodes: vi.fn(),
    });

    expect(result.isIncrementalRun).toBe(false);
  });
});

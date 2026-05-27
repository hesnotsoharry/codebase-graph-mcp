/**
 * autoSync.test.ts — Unit tests for AutoSyncWatcher.
 *
 * Covers: 300ms application-layer debounce,
 * initWithLaunchDiff dispatching to worker via runLaunchDiff,
 * pollForChanges sliced-window reconciliation, and onFileChange debounce.
 */

import fsp from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the worker client — AutoSyncWatcher.triggerReindex and initWithLaunchDiff
// route through the injected IndexingWorkerClient (no singleton in standalone pkg).
const mockRunIndex = vi.fn().mockResolvedValue({
  success: true,
  filesIndexed: 1,
  filesSkipped: 0,
  nodesCreated: 0,
  edgesCreated: 0,
  errors: [],
  durationMs: 10,
  incremental: true,
  projectName: 'test',
});

const mockRunLaunchDiff = vi.fn().mockResolvedValue({
  staleCount: 0,
  deletedCount: 0,
  reindexed: false,
  durationMs: 5,
});

import type { AutoSyncOptions } from './autoSync';
import { AutoSyncWatcher } from './autoSync';
import type { GraphDatabase } from './graphDatabase';
import type { IndexingPipeline } from './indexingPipeline';
import type { IndexingWorkerClient } from './indexingWorkerClient';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type FakeHashRecord = {
  project: string;
  rel_path: string;
  content_hash: string;
  mtime_ns: number;
  size: number;
};

function makeDb(hashes: FakeHashRecord[] = []): GraphDatabase {
  return {
    getNodeCount: vi.fn().mockReturnValue(0),
    getAllFileHashes: vi.fn().mockReturnValue(hashes),
  } as unknown as GraphDatabase;
}

function makePipeline(): IndexingPipeline {
  return {
    index: vi.fn().mockResolvedValue({
      success: true,
      filesIndexed: 1,
      filesSkipped: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [],
      durationMs: 10,
      incremental: true,
      projectName: 'test',
    }),
  } as unknown as IndexingPipeline;
}

function makeWorkerClient(): IndexingWorkerClient {
  return {
    runIndex: mockRunIndex,
    runLaunchDiff: mockRunLaunchDiff,
    isIndexingInProgress: vi.fn().mockReturnValue(false),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as IndexingWorkerClient;
}

function makeOpts(overrides: Partial<AutoSyncOptions> = {}): AutoSyncOptions {
  return {
    projectRoot: '/tmp/test-project',
    projectName: 'test-project',
    db: makeDb(),
    pipeline: makePipeline(),
    workerClient: makeWorkerClient(),
    ...overrides,
  };
}

// ─── 300ms application-layer debounce ─────────────────────────────────────────

describe('receiveWatcherEvent — 300ms app-layer debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onFileChange once after 300ms silence when events arrive rapidly', () => {
    const onFileChange = vi.fn();
    const watcher = new AutoSyncWatcher(makeOpts());
    // Spy on the public onFileChange to count invocations
    vi.spyOn(watcher, 'onFileChange').mockImplementation(onFileChange);

    // Fire 5 events within 100ms
    watcher.receiveWatcherEvent('/tmp/test-project/a.ts');
    watcher.receiveWatcherEvent('/tmp/test-project/b.ts');
    vi.advanceTimersByTime(50);
    watcher.receiveWatcherEvent('/tmp/test-project/c.ts');
    watcher.receiveWatcherEvent('/tmp/test-project/d.ts');
    vi.advanceTimersByTime(50);
    watcher.receiveWatcherEvent('/tmp/test-project/e.ts');

    // No drain yet — 300ms has not elapsed since last event
    expect(onFileChange).not.toHaveBeenCalled();

    // Advance past the debounce window
    vi.advanceTimersByTime(300);

    // Drain fires exactly once with all 5 deduplicated paths
    expect(onFileChange).toHaveBeenCalledTimes(1);
    const paths: string[] = onFileChange.mock.calls[0][0];
    expect(paths).toHaveLength(5);
    expect(paths).toContain('/tmp/test-project/a.ts');
    expect(paths).toContain('/tmp/test-project/e.ts');
  });

  it('deduplicates the same path sent multiple times', () => {
    const onFileChange = vi.fn();
    const watcher = new AutoSyncWatcher(makeOpts());
    vi.spyOn(watcher, 'onFileChange').mockImplementation(onFileChange);

    watcher.receiveWatcherEvent('/tmp/test-project/a.ts');
    watcher.receiveWatcherEvent('/tmp/test-project/a.ts');
    watcher.receiveWatcherEvent('/tmp/test-project/a.ts');
    vi.advanceTimersByTime(300);

    expect(onFileChange).toHaveBeenCalledTimes(1);
    const paths: string[] = onFileChange.mock.calls[0][0];
    expect(paths).toHaveLength(1);
  });

  it('resets the 300ms window on each new event', () => {
    const onFileChange = vi.fn();
    const watcher = new AutoSyncWatcher(makeOpts());
    vi.spyOn(watcher, 'onFileChange').mockImplementation(onFileChange);

    watcher.receiveWatcherEvent('/tmp/test-project/a.ts');
    vi.advanceTimersByTime(299);
    // Reset: a new event arrives before timeout fires
    watcher.receiveWatcherEvent('/tmp/test-project/b.ts');
    vi.advanceTimersByTime(299);
    // Still not fired — window was reset
    expect(onFileChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFileChange).toHaveBeenCalledTimes(1);
  });

  it('does not fire after dispose', () => {
    const onFileChange = vi.fn();
    const watcher = new AutoSyncWatcher(makeOpts());
    vi.spyOn(watcher, 'onFileChange').mockImplementation(onFileChange);

    watcher.receiveWatcherEvent('/tmp/test-project/a.ts');
    watcher.dispose();
    vi.advanceTimersByTime(400);
    expect(onFileChange).not.toHaveBeenCalled();
  });
});

// ─── initWithLaunchDiff ───────────────────────────────────────────────────────

describe('initWithLaunchDiff', () => {
  beforeEach(() => {
    mockRunLaunchDiff.mockClear();
  });

  it('dispatches runLaunchDiff to the worker with correct project opts', async () => {
    const watcher = new AutoSyncWatcher(
      makeOpts({ projectRoot: '/tmp/proj', projectName: 'my-proj' }),
    );
    await watcher.initWithLaunchDiff();
    expect(mockRunLaunchDiff).toHaveBeenCalledOnce();
    expect(mockRunLaunchDiff).toHaveBeenCalledWith({
      projectRoot: '/tmp/proj',
      projectName: 'my-proj',
    });
  });

  it('completes without error when worker returns a no-op result', async () => {
    mockRunLaunchDiff.mockResolvedValueOnce({
      staleCount: 0,
      deletedCount: 0,
      reindexed: false,
      durationMs: 2,
    });
    const watcher = new AutoSyncWatcher(makeOpts());
    await expect(watcher.initWithLaunchDiff()).resolves.toBeUndefined();
  });

  it('calls onError when runLaunchDiff rejects', async () => {
    const onError = vi.fn();
    mockRunLaunchDiff.mockRejectedValueOnce(new Error('worker failed'));
    const watcher = new AutoSyncWatcher(makeOpts({ onError }));
    await watcher.initWithLaunchDiff();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].message).toBe('worker failed');
  });

  it('is a no-op when disposed before dispatch', async () => {
    const watcher = new AutoSyncWatcher(makeOpts());
    watcher.dispose();
    await watcher.initWithLaunchDiff();
    expect(mockRunLaunchDiff).not.toHaveBeenCalled();
  });
});

// ─── pollForChanges — sliced reconciliation ───────────────────────────────────

/** Build N fake hash records. Paths are synthetic (non-existent by default). */
function makeHashes(count: number, projectName = 'test-project'): FakeHashRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    project: projectName,
    rel_path: `src/file${i}.ts`,
    content_hash: `hash${i}`,
    mtime_ns: 1_000_000 * (i + 1),
    size: 100 + i,
  }));
}

describe('pollForChanges — sliced reconciliation', () => {
  let statSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockRunIndex.mockClear();
    // By default: stat throws ENOENT (file not found) — every record is "changed"
    // Override per-test as needed.
    statSpy = vi
      .spyOn(fsp, 'stat')
      .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  afterEach(() => {
    statSpy.mockRestore();
  });

  it('scans at most MAX_FILES_PER_POLL records per cycle', async () => {
    // 500 records → only first 100 should be stat'd in one pollForChanges call
    const hashes = makeHashes(500);
    const watcher = new AutoSyncWatcher(makeOpts({ db: makeDb(hashes) }));

    await watcher.pollForChanges();

    expect(statSpy).toHaveBeenCalledTimes(100);
  });

  it('scanOffset advances and wraps after a full pass', async () => {
    // 250 records → 3 calls cover: [0..99], [100..199], [200..249] then offset wraps to 0
    const hashes = makeHashes(250);
    // Stat succeeds with matching values so nothing triggers reindex (avoids noise)
    statSpy.mockImplementation(async (p: unknown) => {
      const filePath = p as string;
      const idx = parseInt(
        path
          .basename(filePath as string)
          .replace('file', '')
          .replace('.ts', ''),
        10,
      );
      return {
        mtimeMs: (1_000_000 * (idx + 1)) / 1e6, // matches stored mtime_ns
        size: 100 + idx, // matches stored size
      } as Awaited<ReturnType<typeof fsp.stat>>;
    });

    const watcher = new AutoSyncWatcher(makeOpts({ db: makeDb(hashes) }));
    const seenPaths = new Set<string>();

    statSpy.mockImplementation(async (p: unknown) => {
      seenPaths.add(p as string);
      const filePath = p as string;
      const idx = parseInt(path.basename(filePath).replace('file', '').replace('.ts', ''), 10);
      return {
        mtimeMs: (1_000_000 * (idx + 1)) / 1e6,
        size: 100 + idx,
      } as Awaited<ReturnType<typeof fsp.stat>>;
    });

    await watcher.pollForChanges(); // covers [0..99]
    await watcher.pollForChanges(); // covers [100..199]
    await watcher.pollForChanges(); // covers [200..249], offset wraps to 0

    expect(statSpy).toHaveBeenCalledTimes(250);
    // All 250 rel_paths must have been stat'd
    for (let i = 0; i < 250; i++) {
      const expected = path.join('/tmp/test-project', `src/file${i}.ts`);
      expect(seenPaths.has(expected)).toBe(true);
    }
  });

  it('returns without triggering reindex when no records mismatch', async () => {
    const hashes = makeHashes(50);
    // Stat returns values that exactly match the stored mtime_ns and size
    statSpy.mockImplementation(async (p: unknown) => {
      const filePath = p as string;
      const idx = parseInt(path.basename(filePath).replace('file', '').replace('.ts', ''), 10);
      return {
        mtimeMs: (1_000_000 * (idx + 1)) / 1e6,
        size: 100 + idx,
      } as Awaited<ReturnType<typeof fsp.stat>>;
    });

    const watcher = new AutoSyncWatcher(makeOpts({ db: makeDb(hashes) }));
    const reindexSpy = vi.spyOn(watcher, 'triggerReindex').mockResolvedValue();

    await watcher.pollForChanges();

    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it('triggers reindex when at least one record mismatches', async () => {
    const hashes = makeHashes(10);
    statSpy.mockImplementation(async (p: unknown) => {
      const filePath = p as string;
      const idx = parseInt(path.basename(filePath).replace('file', '').replace('.ts', ''), 10);
      // Record 5 gets a different mtimeMs → mismatch detected
      const mtimeMs =
        idx === 5
          ? (1_000_000 * (idx + 1)) / 1e6 + 999 // different
          : (1_000_000 * (idx + 1)) / 1e6; // matching
      return {
        mtimeMs,
        size: 100 + idx,
      } as Awaited<ReturnType<typeof fsp.stat>>;
    });

    const watcher = new AutoSyncWatcher(makeOpts({ db: makeDb(hashes) }));
    const reindexSpy = vi.spyOn(watcher, 'triggerReindex').mockResolvedValue();

    await watcher.pollForChanges();

    expect(reindexSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── onFileChange — always triggers debounced reindex ────────────────────────

describe('onFileChange — always triggers debounced reindex', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRunIndex.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['single file', ['/tmp/test-project/a.ts']],
    [
      'five files',
      [
        '/tmp/test-project/a.ts',
        '/tmp/test-project/b.ts',
        '/tmp/test-project/c.ts',
        '/tmp/test-project/d.ts',
        '/tmp/test-project/e.ts',
      ],
    ],
    ['fifty files', Array.from({ length: 50 }, (_, i) => `/tmp/test-project/file${i}.ts`)],
  ])('triggers reindex regardless of batch size — %s', async (_label, files) => {
    const watcher = new AutoSyncWatcher(makeOpts());
    const reindexSpy = vi.spyOn(watcher, 'triggerReindex').mockResolvedValue();

    watcher.onFileChange(files);

    // Debounce has not fired yet
    expect(reindexSpy).not.toHaveBeenCalled();

    // Advance past the 3s DEBOUNCE_MS window
    await vi.advanceTimersByTimeAsync(3000);

    expect(reindexSpy).toHaveBeenCalledTimes(1);
  });

  it('empty array is a no-op', async () => {
    const watcher = new AutoSyncWatcher(makeOpts());
    const reindexSpy = vi.spyOn(watcher, 'triggerReindex').mockResolvedValue();

    watcher.onFileChange([]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it('multiple rapid calls coalesce into a single reindex', async () => {
    const watcher = new AutoSyncWatcher(makeOpts());
    const reindexSpy = vi.spyOn(watcher, 'triggerReindex').mockResolvedValue();

    watcher.onFileChange(['/tmp/test-project/a.ts']);
    await vi.advanceTimersByTimeAsync(1000);
    watcher.onFileChange(['/tmp/test-project/b.ts']);
    await vi.advanceTimersByTimeAsync(1000);
    watcher.onFileChange(['/tmp/test-project/c.ts']);

    // 3s debounce from last call fires now
    await vi.advanceTimersByTimeAsync(3000);

    expect(reindexSpy).toHaveBeenCalledTimes(1);
  });
});

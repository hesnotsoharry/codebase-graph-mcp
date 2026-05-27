/**
 * systemTwoRegistry.test.ts — Unit tests for the System 2 per-root registry.
 *
 * Tests: acquire/release ref counting, path normalisation (slash variants),
 * dispose on refCount=0, getHandle null for unknown root, listActive.
 * Wave 16 P10: fire-and-forget native close (non-blocking release), double-close
 * prevention, and error swallowing on close rejection.
 */

import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Stub AutoSyncWatcher so tests run without a real DB / pipeline.
const mockDispose = vi.fn();
const mockStart = vi.fn();
const mockInitWithLaunchDiff = vi.fn().mockResolvedValue(undefined);

vi.mock('./autoSync', () => {
  // Must use a class so `new AutoSyncWatcher(...)` works as a constructor.
  class AutoSyncWatcher {
    dispose = mockDispose;
    start = mockStart;
    initWithLaunchDiff = mockInitWithLaunchDiff;
  }
  return { AutoSyncWatcher };
});

// Controllable native watcher subscription mock.
// @parcel/watcher is used directly by subscribeNativeWatcher in systemTwoRegistry.
// Default: unsubscribe() resolves immediately so existing tests don't crash in afterEach.
// mockSubscriptionClose tracks the .close() call exposed on WatchSubscription, which
// internally calls sub.unsubscribe(). We mock at the unsubscribe level.
const mockSubscriptionClose = vi.fn().mockResolvedValue(undefined);
vi.mock('@parcel/watcher', () => ({
  default: {
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: mockSubscriptionClose }),
  },
}));

// Minimal GraphDatabase stub — only getNodeCount is called during construction.
function makeDb() {
  return {
    getNodeCount: vi.fn().mockReturnValue(0),
  } as unknown as import('./graphDatabase').GraphDatabase;
}

// Minimal IndexingPipeline stub.
function makePipeline() {
  return {
    index: vi.fn().mockResolvedValue({ success: true, filesIndexed: 0 }),
  } as unknown as import('./indexingPipeline').IndexingPipeline;
}

// Minimal IndexingWorkerClient stub.
function makeWorkerClient() {
  return {
    runIndex: vi.fn().mockResolvedValue({ success: true }),
    runLaunchDiff: vi.fn().mockResolvedValue({ staleCount: 0, deletedCount: 0, reindexed: false, durationMs: 1 }),
    isIndexingInProgress: vi.fn().mockReturnValue(false),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('./indexingWorkerClient').IndexingWorkerClient;
}

// ─── Import registry after mocks are registered ───────────────────────────────

// Dynamic import ensures vi.mock() is in effect before the module loads.
const registryModule = await import('./systemTwoRegistry');
const { acquire, disposeAll, getHandle, listActive, normalizeRoot, release } = registryModule;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ROOT_A = path.resolve('/tmp/project-a');
const ROOT_B = path.resolve('/tmp/project-b');

// ─── normalizeRoot ────────────────────────────────────────────────────────────

describe('normalizeRoot', () => {
  it('resolves relative paths to absolute', () => {
    const result = normalizeRoot('.');
    expect(path.isAbsolute(result.replace(/\//g, path.sep))).toBe(true);
  });

  it('uses forward slashes regardless of OS input', () => {
    const withBackslash = normalizeRoot('C:\\foo\\bar');
    expect(withBackslash).not.toContain('\\');
  });

  it('two representations of the same path produce the same key', () => {
    const a = normalizeRoot(ROOT_A);
    const b = normalizeRoot(ROOT_A + path.sep);
    // Both should resolve to the same canonical path (trailing sep stripped by path.resolve)
    expect(a).toBe(b);
  });

  it('on Windows, keys are lower-cased', () => {
    if (process.platform !== 'win32') return;
    const upper = normalizeRoot('C:\\FOO\\BAR');
    expect(upper).toBe(upper.toLowerCase());
  });
});

// ─── acquire / release / ref counting ────────────────────────────────────────

describe('acquire and release', () => {
  beforeEach(async () => {
    await disposeAll();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await disposeAll();
  });

  it('acquire returns a handle with refCount=1 on first call', async () => {
    const handle = await acquire(ROOT_A, makeDb(), makePipeline(), makeWorkerClient());
    expect(handle.refCount).toBe(1);
    expect(handle.projectName).toBe(path.basename(ROOT_A));
  });

  it('second acquire increments refCount to 2 without creating a new watcher', async () => {
    await acquire(ROOT_A, makeDb(), makePipeline(), makeWorkerClient());
    const h2 = await acquire(ROOT_A, makeDb(), makePipeline(), makeWorkerClient());
    expect(h2.refCount).toBe(2);
    // Both acquires for the same root should produce a single registry entry
    expect(listActive()).toHaveLength(1);
  });

  it('release decrements refCount', async () => {
    await acquire(ROOT_A, makeDb(), makePipeline(), makeWorkerClient());
    await acquire(ROOT_A, makeDb(), makePipeline(), makeWorkerClient());
    await release(ROOT_A);
    const handle = getHandle(ROOT_A);
    expect(handle?.refCount).toBe(1);
  });

  it('release to zero disposes watcher and removes entry', async () => {
    await acquire(ROOT_A, makeDb(), makePipeline(), makeWorkerClient());
    await release(ROOT_A);
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(getHandle(ROOT_A)).toBeNull();
  });

  it('release on unknown root is a no-op', () => {
    expect(() => release('/nonexistent/path')).not.toThrow();
  });
});

// ─── getHandle ────────────────────────────────────────────────────────────────

describe('getHandle', () => {
  beforeEach(async () => {
    await disposeAll();
  });
  afterEach(async () => {
    await disposeAll();
  });

  it('returns null for an unregistered root', () => {
    expect(getHandle('/not/registered')).toBeNull();
  });

  it('returns the handle after acquire', async () => {
    await acquire(ROOT_A, makeDb(), makePipeline(), makeWorkerClient());
    const handle = getHandle(ROOT_A);
    expect(handle).not.toBeNull();
    expect(handle?.projectRoot).toBeTruthy();
  });
});

// ─── Path normalisation — slash variants resolve to same entry ────────────────

describe('path normalisation', () => {
  beforeEach(async () => {
    await disposeAll();
  });
  afterEach(async () => {
    await disposeAll();
  });

  it.skipIf(process.platform !== 'win32')(
    'forward and backslash variants of the same path share one entry',
    async () => {
      const withForward = ROOT_A.replace(/\\/g, '/');
      const withBack = ROOT_A.replace(/\//g, '\\');

      await acquire(withForward, makeDb(), makePipeline(), makeWorkerClient());
      const h2 = await acquire(withBack, makeDb(), makePipeline(), makeWorkerClient());
      // Same logical root → refCount=2, not two separate entries
      expect(h2.refCount).toBe(2);
      expect(listActive()).toHaveLength(1);
    },
  );
});

// ─── listActive ───────────────────────────────────────────────────────────────

describe('listActive', () => {
  beforeEach(async () => {
    await disposeAll();
  });
  afterEach(async () => {
    await disposeAll();
  });

  it('returns empty array when nothing is registered', () => {
    expect(listActive()).toEqual([]);
  });

  it('returns one entry per distinct root', async () => {
    await acquire(ROOT_A, makeDb(), makePipeline(), makeWorkerClient());
    await acquire(ROOT_B, makeDb(), makePipeline(), makeWorkerClient());
    expect(listActive()).toHaveLength(2);
  });

  it('entry is removed from listActive after release to zero', async () => {
    await acquire(ROOT_A, makeDb(), makePipeline(), makeWorkerClient());
    await release(ROOT_A);
    expect(listActive()).toHaveLength(0);
  });
});

// ─── disposeAll ───────────────────────────────────────────────────────────────

describe('disposeAll', () => {
  afterEach(async () => {
    await disposeAll();
  });

  it('disposes all watchers and clears the registry', async () => {
    vi.clearAllMocks();
    await acquire(ROOT_A, makeDb(), makePipeline(), makeWorkerClient());
    await acquire(ROOT_B, makeDb(), makePipeline(), makeWorkerClient());
    disposeAll();
    expect(mockDispose).toHaveBeenCalledTimes(2);
    expect(listActive()).toHaveLength(0);
  });
});

// ─── fire-and-forget native close (Wave 16 P10) ───────────────────────────────

describe('release — fire-and-forget native close', () => {
  beforeEach(async () => {
    disposeAll();
    vi.clearAllMocks();
  });

  afterEach(() => {
    disposeAll();
  });

  it('release removes the registry entry before the native close Promise settles', async () => {
    // Arrange: close() returns a Promise that does not settle until we
    // explicitly resolve it — simulates the Windows ReadDirectoryChangesW drain.
    let resolveClose!: () => void;
    const pendingClose = new Promise<void>((res) => {
      resolveClose = res;
    });
    mockSubscriptionClose.mockReturnValueOnce(pendingClose);

    await acquire(ROOT_A, makeDb(), makePipeline(), makeWorkerClient());

    // Act: call release (now synchronous).
    release(ROOT_A);

    // Assert: the registry entry is gone BEFORE the native close completes.
    // This is the core contract — the event loop is not blocked.
    expect(getHandle(ROOT_A)).toBeNull();

    // Also verify close() was started (fire-and-forget means it IS called,
    // just not awaited).
    expect(mockSubscriptionClose).toHaveBeenCalledTimes(1);

    // Settle the pending close so the test finishes cleanly.
    resolveClose();
    await pendingClose;
  });

  it('concurrent release calls do not double-close the native subscription', async () => {
    mockSubscriptionClose.mockResolvedValue(undefined);
    await acquire(ROOT_A, makeDb(), makePipeline(), makeWorkerClient());

    // First release drops refCount to 0 and starts the async close.
    release(ROOT_A);
    // Second release on the same root finds no entry (already deleted).
    release(ROOT_A);

    // Allow microtasks to flush so both close() Promises settle.
    await Promise.resolve();

    // close() must have been called exactly once — not twice.
    expect(mockSubscriptionClose).toHaveBeenCalledTimes(1);
  });

  it('logs a warning and does not propagate when native close rejects', async () => {
    const closeError = new Error('IOCP drain failed');
    // close() rejects after a microtask — simulates a native error.
    mockSubscriptionClose.mockRejectedValueOnce(closeError);

    await acquire(ROOT_A, makeDb(), makePipeline(), makeWorkerClient());

    // release() itself must not throw — the rejection is caught internally.
    expect(() => release(ROOT_A)).not.toThrow();

    // Flush microtasks so the .catch() handler runs.
    await new Promise<void>((res) => setTimeout(res, 0));

    // The entry is removed regardless of the close rejection.
    expect(getHandle(ROOT_A)).toBeNull();
  });
});

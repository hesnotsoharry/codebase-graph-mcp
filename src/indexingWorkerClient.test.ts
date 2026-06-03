/**
 * indexingWorkerClient.test.ts — Unit tests for IndexingWorkerClient.
 *
 * Mocks the Worker constructor so no actual worker thread is spawned.
 * Verifies: message round-trip, promise resolution on 'result', rejection on
 * 'error', progress callback invocation, and request queuing.
 */

import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Worker mock ───────────────────────────────────────────────────────────────

class MockWorker extends EventEmitter {
  static lastInstance: MockWorker | null = null;
  postMessage = vi.fn((msg: { type?: string }) => {
    if (msg?.type === 'dispose') {
      queueMicrotask(() => this.emit('exit', 0));
    }
  });
  terminate = vi.fn().mockResolvedValue(0);

  constructor() {
    super();
    MockWorker.lastInstance = this;
  }
}

vi.mock('worker_threads', () => ({
  Worker: MockWorker,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeResult() {
  return {
    projectName: 'proj',
    success: true,
    filesIndexed: 5,
    filesSkipped: 0,
    nodesCreated: 20,
    edgesCreated: 8,
    errors: [] as string[],
    durationMs: 100,
    incremental: false,
  };
}

function makeOptions(overrides = {}) {
  return {
    projectRoot: '/tmp/proj',
    projectName: 'proj',
    ...overrides,
  };
}

/** Minimal options needed to construct an IndexingWorkerClient in tests. */
function makeClientOpts() {
  return {
    workerEntryPath: '/fake/worker.js',
    dbPath: '/fake/graph.db',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IndexingWorkerClient', () => {
  let client: import('./indexingWorkerClient').IndexingWorkerClient;

  beforeEach(async () => {
    MockWorker.lastInstance = null;
    const mod = await import('./indexingWorkerClient');
    client = new mod.IndexingWorkerClient(makeClientOpts());
  });

  afterEach(async () => {
    await client.dispose();
    vi.resetModules();
  });

  it('resolves promise when worker posts a result message', async () => {
    const promise = client.runIndex(makeOptions());

    const worker = MockWorker.lastInstance!;
    expect(worker.postMessage).toHaveBeenCalledOnce();

    const { requestId } = worker.postMessage.mock.calls[0][0] as { requestId: string };
    worker.emit('message', { type: 'result', requestId, result: makeResult() });

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(5);
  });

  it('rejects promise when worker posts an error message', async () => {
    const promise = client.runIndex(makeOptions());

    const worker = MockWorker.lastInstance!;
    const { requestId } = worker.postMessage.mock.calls[0][0] as { requestId: string };
    worker.emit('message', { type: 'error', requestId, message: 'parse failed' });

    await expect(promise).rejects.toThrow('parse failed');
  });

  it('invokes onProgress callback for progress messages', async () => {
    const onProgress = vi.fn();
    const promise = client.runIndex(makeOptions({ onProgress }));

    const worker = MockWorker.lastInstance!;
    const { requestId } = worker.postMessage.mock.calls[0][0] as { requestId: string };

    const progress = {
      phase: 'parsing',
      filesTotal: 10,
      filesProcessed: 3,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [],
      startedAt: Date.now(),
      elapsedMs: 50,
    };
    worker.emit('message', { type: 'progress', requestId, progress });
    expect(onProgress).toHaveBeenCalledWith(progress);

    // resolve so the test doesn't hang
    worker.emit('message', { type: 'result', requestId, result: makeResult() });
    await promise;
  });

  it('queues a second request until first resolves', async () => {
    const p1 = client.runIndex(makeOptions({ projectName: 'p1' }));
    const p2 = client.runIndex(makeOptions({ projectName: 'p2' }));

    const worker = MockWorker.lastInstance!;
    // Only one postMessage call so far — second is queued
    expect(worker.postMessage).toHaveBeenCalledTimes(1);

    const req1 = worker.postMessage.mock.calls[0][0] as { requestId: string };
    worker.emit('message', { type: 'result', requestId: req1.requestId, result: makeResult() });
    await p1;

    // Now the second request should have been dispatched
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    const req2 = worker.postMessage.mock.calls[1][0] as { requestId: string };
    worker.emit('message', { type: 'result', requestId: req2.requestId, result: makeResult() });
    await p2;
  });

  it('strips onProgress from the serialised options sent to worker', async () => {
    const onProgress = vi.fn();
    const promise = client.runIndex(makeOptions({ onProgress }));

    const worker = MockWorker.lastInstance!;
    const msg = worker.postMessage.mock.calls[0][0] as { options: Record<string, unknown> };
    expect('onProgress' in msg.options).toBe(false);

    const { requestId } = worker.postMessage.mock.calls[0][0] as { requestId: string };
    worker.emit('message', { type: 'result', requestId, result: makeResult() });
    await promise;
  });

  it('rejects all pending requests on worker error event', async () => {
    const p1 = client.runIndex(makeOptions());
    MockWorker.lastInstance!.emit('error', new Error('worker crashed'));
    await expect(p1).rejects.toThrow('worker crashed');
  });

  it('dispose rejects in-flight requests', async () => {
    const p1 = client.runIndex(makeOptions());
    await client.dispose();
    await expect(p1).rejects.toThrow('disposed');
  });

  it('dispose sends a graceful dispose message and waits for exit', async () => {
    const p1 = client.runIndex(makeOptions());
    const worker = MockWorker.lastInstance!;
    // Stop the default auto-exit behavior so we can observe pending dispose.
    worker.postMessage.mockImplementation(() => undefined);

    let settled = false;
    const disposePromise = client.dispose().then(() => {
      settled = true;
    });

    await expect(p1).rejects.toThrow('disposed');
    await Promise.resolve();
    expect(settled).toBe(false);

    const disposeCall = worker.postMessage.mock.calls.find(
      (call) => (call[0] as { type?: string })?.type === 'dispose',
    );
    expect(disposeCall).toBeDefined();

    worker.emit('exit', 0);
    await disposePromise;
    expect(settled).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('dispose falls back to terminate when the worker does not exit', async () => {
    vi.useFakeTimers();
    try {
      const p1 = client.runIndex(makeOptions());
      const worker = MockWorker.lastInstance!;
      worker.postMessage.mockImplementation(() => undefined);

      const disposePromise = client.dispose();
      await expect(p1).rejects.toThrow('disposed');

      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
      await disposePromise;
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── runLaunchDiff ─────────────────────────────────────────────────────────────

describe('IndexingWorkerClient.runLaunchDiff', () => {
  let client: import('./indexingWorkerClient').IndexingWorkerClient;

  function makeLaunchDiffResult() {
    return {
      staleCount: 2,
      deletedCount: 1,
      reindexed: true,
      durationMs: 80,
    };
  }

  beforeEach(async () => {
    MockWorker.lastInstance = null;
    const mod = await import('./indexingWorkerClient');
    client = new mod.IndexingWorkerClient(makeClientOpts());
  });

  afterEach(async () => {
    await client.dispose();
    vi.resetModules();
  });

  it('resolves with LaunchDiffResult when worker posts launchDiffResult', async () => {
    const promise = client.runLaunchDiff({ projectRoot: '/tmp/p', projectName: 'p' });

    const worker = MockWorker.lastInstance!;
    expect(worker.postMessage).toHaveBeenCalledOnce();

    const msg = worker.postMessage.mock.calls[0][0] as {
      type: string;
      requestId: string;
      projectRoot: string;
      projectName: string;
    };
    expect(msg.type).toBe('launchDiff');
    expect(msg.projectRoot).toBe('/tmp/p');
    expect(msg.projectName).toBe('p');

    worker.emit('message', {
      type: 'launchDiffResult',
      requestId: msg.requestId,
      result: makeLaunchDiffResult(),
    });

    const result = await promise;
    expect(result.staleCount).toBe(2);
    expect(result.deletedCount).toBe(1);
    expect(result.reindexed).toBe(true);
    expect(result.durationMs).toBe(80);
  });

  it('passes skipTsEnrichment: true through the launchDiff message when caller provides it (Wave 4 P3 oracle)', async () => {
    // Contract: when client.runLaunchDiff is called with skipTsEnrichment: true,
    // the message posted to the worker MUST include skipTsEnrichment: true.
    // This flag tells handleLaunchDiff to skip ts-morph enrichment (Pass 6/7).
    // Pre-impl: dispatchLaunchDiff does NOT pass skipTsEnrichment — this test FAILS.
    // Post-impl: dispatchLaunchDiff will pass it through — test PASSES.
    const promise = (
      client.runLaunchDiff as unknown as (opts: {
        projectRoot: string;
        projectName: string;
        skipTsEnrichment?: boolean;
      }) => Promise<import('./indexingWorkerTypes').LaunchDiffResult>
    )({
      projectRoot: '/tmp/p',
      projectName: 'p',
      skipTsEnrichment: true,
    });

    const worker = MockWorker.lastInstance!;
    expect(worker.postMessage).toHaveBeenCalledOnce();

    const msg = worker.postMessage.mock.calls[0][0] as {
      type: string;
      requestId: string;
      projectRoot: string;
      projectName: string;
      skipTsEnrichment?: boolean;
    };
    expect(msg.type).toBe('launchDiff');
    expect(msg.skipTsEnrichment).toBe(true);

    worker.emit('message', {
      type: 'launchDiffResult',
      requestId: msg.requestId,
      result: makeLaunchDiffResult(),
    });

    await promise;
  });

  it('omits skipTsEnrichment when caller does not provide it (regression: old behavior)', async () => {
    // Contract: when skipTsEnrichment is NOT provided, ts-morph enrichment runs (current behavior).
    // The message should either not have the field, or have it as undefined/false.
    // This test confirms the regression path and that normal (enrichment-enabled) flow works.
    const promise = client.runLaunchDiff({ projectRoot: '/tmp/p', projectName: 'p' });

    const worker = MockWorker.lastInstance!;
    expect(worker.postMessage).toHaveBeenCalledOnce();

    const msg = worker.postMessage.mock.calls[0][0] as {
      type: string;
      requestId: string;
      projectRoot: string;
      projectName: string;
      skipTsEnrichment?: boolean;
    };
    expect(msg.type).toBe('launchDiff');
    // When skipTsEnrichment is unset, it should NOT be true (i.e. enrichment is NOT skipped).
    expect(msg.skipTsEnrichment).not.toBe(true);

    worker.emit('message', {
      type: 'launchDiffResult',
      requestId: msg.requestId,
      result: makeLaunchDiffResult(),
    });

    await promise;
  });

  it('passes skipTsEnrichment: false explicitly (contract validation)', async () => {
    // This test validates the full contract shape: when skipTsEnrichment is
    // explicitly false, the message must include it (or be clearly false).
    // This ensures the worker can distinguish between unset and explicitly false
    // if that distinction becomes necessary in the future.
    const promise = (
      client.runLaunchDiff as unknown as (opts: {
        projectRoot: string;
        projectName: string;
        skipTsEnrichment?: boolean;
      }) => Promise<import('./indexingWorkerTypes').LaunchDiffResult>
    )({
      projectRoot: '/tmp/p',
      projectName: 'p',
      skipTsEnrichment: false,
    });

    const worker = MockWorker.lastInstance!;
    expect(worker.postMessage).toHaveBeenCalledOnce();

    const msg = worker.postMessage.mock.calls[0][0] as {
      type: string;
      requestId: string;
      projectRoot: string;
      projectName: string;
      skipTsEnrichment?: boolean;
    };
    expect(msg.type).toBe('launchDiff');
    // When explicitly false, enrichment should run (not skipped).
    // The message either includes the field (false) or omits it.
    expect(msg.skipTsEnrichment).not.toBe(true);

    worker.emit('message', {
      type: 'launchDiffResult',
      requestId: msg.requestId,
      result: makeLaunchDiffResult(),
    });

    await promise;
  });

  it('rejects promise when worker posts error for a launchDiff request', async () => {
    const promise = client.runLaunchDiff({ projectRoot: '/tmp/p', projectName: 'p' });

    const worker = MockWorker.lastInstance!;
    const msg = worker.postMessage.mock.calls[0][0] as { requestId: string };
    worker.emit('message', { type: 'error', requestId: msg.requestId, message: 'stat failed' });

    await expect(promise).rejects.toThrow('stat failed');
  });

  it('serializes runLaunchDiff + runIndex through the same queue', async () => {
    const p1 = client.runLaunchDiff({ projectRoot: '/tmp/p', projectName: 'p' });
    const p2 = client.runIndex(makeOptions());

    const worker = MockWorker.lastInstance!;
    // Only the first (launchDiff) should have been sent
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect((worker.postMessage.mock.calls[0][0] as { type: string }).type).toBe('launchDiff');

    const req1 = worker.postMessage.mock.calls[0][0] as { requestId: string };
    worker.emit('message', {
      type: 'launchDiffResult',
      requestId: req1.requestId,
      result: { staleCount: 0, deletedCount: 0, reindexed: false, durationMs: 1 },
    });
    await p1;

    // Now the runIndex job should have been dispatched
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect((worker.postMessage.mock.calls[1][0] as { type: string }).type).toBe('indexRepository');

    const req2 = worker.postMessage.mock.calls[1][0] as { requestId: string };
    worker.emit('message', { type: 'result', requestId: req2.requestId, result: makeResult() });
    await p2;
  });

  it('rejects launchDiff on worker crash', async () => {
    const promise = client.runLaunchDiff({ projectRoot: '/tmp/p', projectName: 'p' });
    MockWorker.lastInstance!.emit('error', new Error('worker crashed'));
    await expect(promise).rejects.toThrow('worker crashed');
  });

  it('rejects launchDiff when client is disposed', async () => {
    const promise = client.runLaunchDiff({ projectRoot: '/tmp/p', projectName: 'p' });
    await client.dispose();
    await expect(promise).rejects.toThrow('disposed');
  });
});

// ── Constructor opts ──────────────────────────────────────────────────────────
// The standalone package removes the module-level singleton. Callers supply
// an explicit IndexingWorkerClientOptions to the constructor.

describe('IndexingWorkerClient constructor opts', () => {
  it('constructs without error given workerEntryPath and dbPath', async () => {
    const mod = await import('./indexingWorkerClient');
    const client = new mod.IndexingWorkerClient({
      workerEntryPath: '/some/worker.js',
      dbPath: '/some/graph.db',
    });
    expect(client).toBeInstanceOf(mod.IndexingWorkerClient);
    await client.dispose();
  });

  it('two instances with different opts are independent objects', async () => {
    const mod = await import('./indexingWorkerClient');
    const a = new mod.IndexingWorkerClient({ workerEntryPath: '/a/worker.js', dbPath: '/a/g.db' });
    const b = new mod.IndexingWorkerClient({ workerEntryPath: '/b/worker.js', dbPath: '/b/g.db' });
    expect(a).not.toBe(b);
    await a.dispose();
    await b.dispose();
  });
});

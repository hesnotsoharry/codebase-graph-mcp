/**
 * indexingWorker.test.ts — Import-parse smoke test for indexingWorker.ts.
 *
 * The worker is a separate entry point that relies on worker_threads
 * `parentPort` at module scope.  Full round-trip testing is covered by
 * indexingWorkerClient.test.ts (which mocks the Worker constructor).
 * This file only verifies the module can be imported without throwing.
 */

import { describe, expect, it, vi } from 'vitest';

// Stub worker_threads before the module is loaded so parentPort.on() does not
// blow up outside an actual worker context.
vi.mock('worker_threads', () => ({
  parentPort: {
    on: vi.fn(),
    postMessage: vi.fn(),
  },
  workerData: {},
  // W18 W3: logger transitively imports isMainThread to route between
  // console.warn (worker) and log.info (main); mock must expose it.
  isMainThread: false,
}));

// Stub heavy native deps so the module graph resolves in vitest.
vi.mock('./graphDatabase', () => ({
  GraphDatabase: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('./treeSitterParser', () => ({
  TreeSitterParser: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('./indexingPipeline', () => ({
  IndexingPipeline: vi.fn().mockImplementation(() => ({
    index: vi.fn().mockResolvedValue({
      projectName: 'test',
      success: true,
      filesIndexed: 0,
      filesSkipped: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [],
      durationMs: 0,
      incremental: false,
    }),
  })),
}));

describe('indexingWorker module', () => {
  it('imports without throwing', async () => {
    // Dynamic import so vi.mock() stubs are in place first.
    await expect(import('./indexingWorker')).resolves.toBeDefined();
  });

  it('registers a message listener on parentPort', async () => {
    const { parentPort } = await import('worker_threads');
    expect(parentPort?.on).toHaveBeenCalledWith('message', expect.any(Function));
  });
});

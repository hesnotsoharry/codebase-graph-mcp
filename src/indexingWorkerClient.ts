/**
 * indexingWorkerClient.ts — Main-process-side client for the indexing worker.
 *
 * Keeps a singleton Worker (lazy-spawned on first runIndex call).  Queues
 * concurrent requests so the worker processes one at a time — this matches
 * System 1's behaviour and keeps SQLite writes serialised.
 *
 * Exposes runIndex(options) => Promise<IndexingResult> which mirrors the
 * IndexingPipeline.index() signature so callers need no changes.
 */

import { Worker } from 'worker_threads';

import type { Logger } from './loggerInterface';
import { consoleErrorLogger } from './loggerInterface';
import { Mutex } from './concurrency';
import type { IndexingOptions, IndexingResult } from './indexingPipelineTypes';
import type {
  IndexingWorkerResponse,
  IndexRequestOptions,
  LaunchDiffResult,
} from './indexingWorkerTypes';

// ── Path resolution ───────────────────────────────────────────────────────────

/**
 * In the standalone package the worker path and DB path are constructor
 * parameters — no __dirname magic, no Electron paths.
 *
 * workerEntryPath: absolute path to the compiled indexingWorker.js.
 *   Caller (Phase 4 MCP entry point) computes this from the package dist dir.
 *
 * dbPath: absolute path to the SQLite database file.
 *   Caller derives this from the project root hash.
 */

// ── Pending-request bookkeeping ───────────────────────────────────────────────

interface PendingRequest {
  requestId: string;
  resolve: (result: IndexingResult) => void;
  reject: (err: Error) => void;
  onProgress: IndexingOptions['onProgress'];
}

interface PendingLaunchDiff {
  requestId: string;
  resolve: (result: LaunchDiffResult) => void;
  reject: (err: Error) => void;
}

// ── Client class ──────────────────────────────────────────────────────────────

export interface IndexingWorkerClientOptions {
  /** Absolute path to the compiled indexingWorker.js file in the package dist dir. */
  workerEntryPath: string;
  /** Absolute path to the SQLite database file. Passed to the worker via workerData. */
  dbPath: string;
  /** Logger instance. Defaults to consoleErrorLogger. */
  logger?: Logger;
}

export class IndexingWorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();
  private pendingLaunchDiff = new Map<string, PendingLaunchDiff>();
  private queue: Array<() => void> = [];
  private busy = false;
  private nextId = 0;
  private terminatingWorkers = new WeakSet<Worker>();
  private indexingMutex = new Mutex();
  private mutexAcquired = false;
  private workerEntryPath: string;
  private dbPath: string;
  private logger: Logger;

  constructor(opts: IndexingWorkerClientOptions) {
    this.workerEntryPath = opts.workerEntryPath;
    this.dbPath = opts.dbPath;
    this.logger = opts.logger ?? consoleErrorLogger;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  runIndex(options: IndexingOptions): Promise<IndexingResult> {
    this.logger.info(
      `[trace:workerClient.runIndex] queueDepth=${this.queue.length} busy=${this.busy}`,
    );
    return new Promise((resolve, reject) => {
      this.queue.push(() => this.dispatch(options, resolve, reject));
      this.drainQueue();
    });
  }

  /**
   * Dispatch a launch-time catalog diff to the worker thread.
   * Serializes through the same queue as runIndex so concurrent launchDiff +
   * runIndex requests are handled one at a time.
   */
  runLaunchDiff(opts: { projectRoot: string; projectName: string; skipTsEnrichment?: boolean }): Promise<LaunchDiffResult> {
    this.logger.info(
      `[trace:workerClient.runLaunchDiff] queueDepth=${this.queue.length} busy=${this.busy}`,
    );
    return new Promise((resolve, reject) => {
      this.queue.push(() => this.dispatchLaunchDiff(opts, resolve, reject));
      this.drainQueue();
    });
  }

  /**
   * Check if indexing is currently in progress.
   * Used by GC to avoid running concurrently with the indexing worker.
   */
  isIndexingInProgress(): boolean {
    return this.mutexAcquired;
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    if (worker) this.terminatingWorkers.add(worker);
    this.worker = null;
    for (const p of this.pending.values()) {
      p.reject(new Error('IndexingWorkerClient disposed'));
    }
    this.pending.clear();
    for (const p of this.pendingLaunchDiff.values()) {
      p.reject(new Error('IndexingWorkerClient disposed'));
    }
    this.pendingLaunchDiff.clear();
    this.queue = [];
    this.busy = false;
    if (!worker) return;
    await this.shutdownWorker(worker);
  }

  private async shutdownWorker(worker: Worker): Promise<void> {
    const gracefulExit = this.waitForGracefulExit(worker);
    try {
      worker.postMessage({ type: 'dispose', requestId: `dispose-${this.nextId++}` });
    } catch {
      /* worker may already be exiting */
    }
    const exited = await gracefulExit;
    if (exited) return;
    try {
      await worker.terminate();
    } catch {
      /* already gone */
    }
  }

  private waitForGracefulExit(worker: Worker): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        worker.off('exit', onExit);
        resolve(false);
      }, 2000);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      worker.once('exit', onExit);
    });
  }

  // ── Worker lifecycle ────────────────────────────────────────────────────────

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(this.workerEntryPath, { workerData: { dbPath: this.dbPath } });
    worker.on('message', (msg: IndexingWorkerResponse) => this.handleMessage(msg));
    worker.on('error', (err) => {
      this.logger.error('[indexingWorker] worker error:', err);
      this.rejectAll(err);
    });
    worker.on('exit', (code) => {
      const terminating = this.terminatingWorkers.has(worker);
      if (code !== 0 && !terminating)
        this.logger.warn(`[indexingWorker] exited with code ${code}`);
      if (this.worker === worker) this.worker = null;
      if (!terminating) this.rejectAll(new Error(`Worker exited with code ${code}`));
    });
    this.worker = worker;
    return worker;
  }

  // ── Dispatch & queue ────────────────────────────────────────────────────────

  private dispatch(
    options: IndexingOptions,
    resolve: PendingRequest['resolve'],
    reject: PendingRequest['reject'],
  ): void {
    this.busy = true;
    const requestId = String(this.nextId++);
    const { onProgress, ...rest } = options;
    const serialisable: IndexRequestOptions = rest;

    // Mark that indexing is in progress.
    // GC will check isIndexingInProgress() and skip if true.
    if (!this.mutexAcquired) {
      this.indexingMutex.acquire();
      this.mutexAcquired = true;
    }

    this.pending.set(requestId, { requestId, resolve, reject, onProgress });
    this.ensureWorker().postMessage({ type: 'indexRepository', requestId, options: serialisable });
  }

  private dispatchLaunchDiff(
    opts: { projectRoot: string; projectName: string; skipTsEnrichment?: boolean },
    resolve: PendingLaunchDiff['resolve'],
    reject: PendingLaunchDiff['reject'],
  ): void {
    this.busy = true;
    const requestId = String(this.nextId++);
    this.pendingLaunchDiff.set(requestId, { requestId, resolve, reject });
    this.ensureWorker().postMessage({
      type: 'launchDiff',
      requestId,
      projectRoot: opts.projectRoot,
      projectName: opts.projectName,
      skipTsEnrichment: opts.skipTsEnrichment,
    });
  }

  private drainQueue(): void {
    if (this.busy || this.queue.length === 0) return;
    const next = this.queue.shift();
    next?.();
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private handleMessage(msg: IndexingWorkerResponse): void {
    switch (msg.type) {
      case 'progress':
        this.pending.get(msg.requestId)?.onProgress?.(msg.progress);
        break;
      case 'result':
        this.settle(msg.requestId, (p) => p.resolve(msg.result));
        break;
      case 'launchDiffResult':
        this.settleLaunchDiff(msg.requestId, (p) => p.resolve(msg.result));
        break;
      case 'error':
        // Could be from either launchDiff or indexRepository — check both maps.
        if (this.pendingLaunchDiff.has(msg.requestId)) {
          this.settleLaunchDiff(msg.requestId, (p) => p.reject(new Error(msg.message)));
        } else {
          this.settle(msg.requestId, (p) => p.reject(new Error(msg.message)));
        }
        break;
      case 'disposed':
        // Ack — graceful shutdown completion is observed via the worker 'exit' event.
        break;
    }
  }

  private settleLaunchDiff(requestId: string, fn: (p: PendingLaunchDiff) => void): void {
    const p = this.pendingLaunchDiff.get(requestId);
    if (!p) return;
    this.pendingLaunchDiff.delete(requestId);
    this.busy = false;
    fn(p);
    this.drainQueue();
  }

  private settle(requestId: string, fn: (p: PendingRequest) => void): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    this.busy = false;
    fn(p);
    // Release the indexing mutex once all pending requests are done.
    // This allows GC to run on the next cycle.
    if (this.pending.size === 0 && this.mutexAcquired) {
      this.indexingMutex.release();
      this.mutexAcquired = false;
    }
    this.drainQueue();
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    for (const p of this.pendingLaunchDiff.values()) p.reject(err);
    this.pendingLaunchDiff.clear();
    this.busy = false;
    this.queue = [];
    // Release the indexing mutex if we had acquired it.
    if (this.mutexAcquired) {
      this.indexingMutex.release();
      this.mutexAcquired = false;
    }
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────
// In the standalone package the worker client is created by the caller (Phase 4
// MCP entry point) and passed into classes that need it as a constructor parameter.
// The singleton factory is preserved here so that classes like AutoSyncWatcher
// and GraphGc that originally called getIndexingWorkerClient() can still compile;
// they are updated to accept the client as a constructor parameter and no longer
// call this singleton. The singleton function itself is intentionally not exported —
// callers must supply an explicit IndexingWorkerClientOptions.

// (No module-level singleton exported in the standalone package.)

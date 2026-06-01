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
import { consoleErrorLogger } from './loggerInterface.js';
import { Mutex } from './concurrency.js';
export class IndexingWorkerClient {
    worker = null;
    pending = new Map();
    pendingLaunchDiff = new Map();
    queue = [];
    busy = false;
    nextId = 0;
    terminatingWorkers = new WeakSet();
    indexingMutex = new Mutex();
    mutexAcquired = false;
    workerEntryPath;
    dbPath;
    logger;
    constructor(opts) {
        this.workerEntryPath = opts.workerEntryPath;
        this.dbPath = opts.dbPath;
        this.logger = opts.logger ?? consoleErrorLogger;
    }
    // ── Public API ──────────────────────────────────────────────────────────────
    runIndex(options) {
        this.logger.info(`[trace:workerClient.runIndex] queueDepth=${this.queue.length} busy=${this.busy}`);
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
    runLaunchDiff(opts) {
        this.logger.info(`[trace:workerClient.runLaunchDiff] queueDepth=${this.queue.length} busy=${this.busy}`);
        return new Promise((resolve, reject) => {
            this.queue.push(() => this.dispatchLaunchDiff(opts, resolve, reject));
            this.drainQueue();
        });
    }
    /**
     * Check if indexing is currently in progress.
     * Used by GC to avoid running concurrently with the indexing worker.
     */
    isIndexingInProgress() {
        return this.mutexAcquired;
    }
    async dispose() {
        const worker = this.worker;
        if (worker)
            this.terminatingWorkers.add(worker);
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
        if (!worker)
            return;
        await this.shutdownWorker(worker);
    }
    async shutdownWorker(worker) {
        const gracefulExit = this.waitForGracefulExit(worker);
        try {
            worker.postMessage({ type: 'dispose', requestId: `dispose-${this.nextId++}` });
        }
        catch {
            /* worker may already be exiting */
        }
        const exited = await gracefulExit;
        if (exited)
            return;
        try {
            await worker.terminate();
        }
        catch {
            /* already gone */
        }
    }
    waitForGracefulExit(worker) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                worker.off('exit', onExit);
                resolve(false);
            }, 2000);
            const onExit = () => {
                clearTimeout(timer);
                resolve(true);
            };
            worker.once('exit', onExit);
        });
    }
    // ── Worker lifecycle ────────────────────────────────────────────────────────
    ensureWorker() {
        if (this.worker)
            return this.worker;
        const worker = new Worker(this.workerEntryPath, { workerData: { dbPath: this.dbPath } });
        worker.on('message', (msg) => this.handleMessage(msg));
        worker.on('error', (err) => {
            this.logger.error('[indexingWorker] worker error:', err);
            this.rejectAll(err);
        });
        worker.on('exit', (code) => {
            const terminating = this.terminatingWorkers.has(worker);
            if (code !== 0 && !terminating)
                this.logger.warn(`[indexingWorker] exited with code ${code}`);
            if (this.worker === worker)
                this.worker = null;
            if (!terminating)
                this.rejectAll(new Error(`Worker exited with code ${code}`));
        });
        this.worker = worker;
        return worker;
    }
    // ── Dispatch & queue ────────────────────────────────────────────────────────
    dispatch(options, resolve, reject) {
        this.busy = true;
        const requestId = String(this.nextId++);
        const { onProgress, ...rest } = options;
        const serialisable = rest;
        // Mark that indexing is in progress.
        // GC will check isIndexingInProgress() and skip if true.
        if (!this.mutexAcquired) {
            this.indexingMutex.acquire();
            this.mutexAcquired = true;
        }
        this.pending.set(requestId, { requestId, resolve, reject, onProgress });
        this.ensureWorker().postMessage({ type: 'indexRepository', requestId, options: serialisable });
    }
    dispatchLaunchDiff(opts, resolve, reject) {
        this.busy = true;
        const requestId = String(this.nextId++);
        this.pendingLaunchDiff.set(requestId, { requestId, resolve, reject });
        this.ensureWorker().postMessage({
            type: 'launchDiff',
            requestId,
            projectRoot: opts.projectRoot,
            projectName: opts.projectName,
        });
    }
    drainQueue() {
        if (this.busy || this.queue.length === 0)
            return;
        const next = this.queue.shift();
        next?.();
    }
    // ── Message handling ────────────────────────────────────────────────────────
    handleMessage(msg) {
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
                }
                else {
                    this.settle(msg.requestId, (p) => p.reject(new Error(msg.message)));
                }
                break;
            case 'disposed':
                // Ack — graceful shutdown completion is observed via the worker 'exit' event.
                break;
        }
    }
    settleLaunchDiff(requestId, fn) {
        const p = this.pendingLaunchDiff.get(requestId);
        if (!p)
            return;
        this.pendingLaunchDiff.delete(requestId);
        this.busy = false;
        fn(p);
        this.drainQueue();
    }
    settle(requestId, fn) {
        const p = this.pending.get(requestId);
        if (!p)
            return;
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
    rejectAll(err) {
        for (const p of this.pending.values())
            p.reject(err);
        this.pending.clear();
        for (const p of this.pendingLaunchDiff.values())
            p.reject(err);
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
//# sourceMappingURL=indexingWorkerClient.js.map
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
import type { Logger } from './loggerInterface';
import type { IndexingOptions, IndexingResult } from './indexingPipelineTypes';
import type { LaunchDiffResult } from './indexingWorkerTypes';
export interface IndexingWorkerClientOptions {
    /** Absolute path to the compiled indexingWorker.js file in the package dist dir. */
    workerEntryPath: string;
    /** Absolute path to the SQLite database file. Passed to the worker via workerData. */
    dbPath: string;
    /** Logger instance. Defaults to consoleErrorLogger. */
    logger?: Logger;
}
export declare class IndexingWorkerClient {
    private worker;
    private pending;
    private pendingLaunchDiff;
    private queue;
    private busy;
    private nextId;
    private terminatingWorkers;
    private indexingMutex;
    private mutexAcquired;
    private workerEntryPath;
    private dbPath;
    private logger;
    constructor(opts: IndexingWorkerClientOptions);
    runIndex(options: IndexingOptions): Promise<IndexingResult>;
    /**
     * Dispatch a launch-time catalog diff to the worker thread.
     * Serializes through the same queue as runIndex so concurrent launchDiff +
     * runIndex requests are handled one at a time.
     */
    runLaunchDiff(opts: {
        projectRoot: string;
        projectName: string;
    }): Promise<LaunchDiffResult>;
    /**
     * Check if indexing is currently in progress.
     * Used by GC to avoid running concurrently with the indexing worker.
     */
    isIndexingInProgress(): boolean;
    dispose(): Promise<void>;
    private shutdownWorker;
    private waitForGracefulExit;
    private ensureWorker;
    private dispatch;
    private dispatchLaunchDiff;
    private drainQueue;
    private handleMessage;
    private settleLaunchDiff;
    private settle;
    private rejectAll;
}
//# sourceMappingURL=indexingWorkerClient.d.ts.map
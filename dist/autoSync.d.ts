/**
 * autoSync.ts — Background watcher that keeps the codebase graph in sync
 * with file changes.
 *
 * Primary mechanism: @parcel/watcher events (wired by systemTwoRegistry)
 * → receiveWatcherEvent → 300ms debounce → debouncedReindex.
 * Reconciliation: a low-frequency stat-based catalog sweep catches missed
 * events (Windows watcher drops under load). Polling is the safety net,
 * not the hot path.
 */
import type { Logger } from './loggerInterface';
import type { GraphDatabase } from './graphDatabase';
import type { IndexingPipeline } from './indexingPipeline';
import type { IndexingWorkerClient } from './indexingWorkerClient';
export interface AutoSyncOptions {
    projectRoot: string;
    projectName: string;
    db: GraphDatabase;
    pipeline: IndexingPipeline;
    /** The indexing worker client — injected rather than fetched from a singleton. */
    workerClient: IndexingWorkerClient;
    /** Logger instance. Defaults to consoleErrorLogger. */
    logger?: Logger;
    onReindexComplete?: (result: {
        filesChanged: number;
        durationMs: number;
    }) => void;
    onError?: (error: Error) => void;
}
export declare class AutoSyncWatcher {
    private timer;
    private debounceTimer;
    private appDebounceTimer;
    private running;
    private disposed;
    private reindexing;
    private reconcileIntervalMs;
    /** Rolling offset into the file-hash catalog for the current scan window. */
    private scanOffset;
    /** Counter incremented on every poll; used for periodic heartbeat logging. */
    private pollCount;
    /** Accumulates file paths during the 300ms app-layer debounce window (OS-level coalescing + app idle gap). */
    private pendingEvents;
    /**
     * Snapshot of watcher-reported absolute paths carried from drainPendingEvents
     * through the 3s DEBOUNCE_MS window to triggerReindex. Passed as changedPaths
     * hint to skip the O(N_all_files) filterChangedFiles scan. Cleared on consume.
     */
    private watcherHintPaths;
    private opts;
    private logger;
    constructor(opts: AutoSyncOptions);
    /** Compute reconciliation cadence from node count. Polling is the safety net; watcher events are the hot path. */
    private static adaptivePollInterval;
    /** Begin the polling timer loop. No-op if already running or disposed. */
    start(): void;
    /** Stop the polling timer. Safe to call multiple times. */
    stop(): void;
    /** Stop polling and mark as permanently disposed. */
    dispose(): void;
    private schedulePoll;
    /**
     * Stat-based change detection. Iterates a rolling window of file hashes in DB,
     * compares mtime_ns and size against current fs.stat. Stats are parallelized
     * with concurrency=32 via mapWithConcurrency. The scanOffset advances by
     * MAX_FILES_PER_POLL each cycle, wrapping at catalog length so successive
     * polls eventually cover the full catalog.
     *
     * If changes are detected and no reindex is already in flight,
     * triggers an incremental reindex.
     */
    pollForChanges(): Promise<void>;
    /**
     * Collect files that have changed based on stat comparison.
     * Reads the full hash catalog once, slices MAX_FILES_PER_POLL records
     * starting at scanOffset, stats them concurrently (concurrency=32), then
     * advances scanOffset (wrapping at catalog length).
     *
     * Returns changed paths and the full catalog size for diagnostics.
     */
    private collectChangedFiles;
    /**
     * Check a single file's stat against the stored hash record.
     * Returns the rel_path if changed/deleted, or null if unchanged.
     */
    private checkFileChanged;
    /**
     * Run pipeline.index() with incremental=true. Guarded by the reindexing
     * flag to prevent concurrent runs. Errors are caught and forwarded to onError.
     */
    private handleReindexResult;
    triggerReindex(): Promise<void>;
    /**
     * Run init: perform a launch-time catalog diff off the main thread to catch
     * changes that happened while the IDE was closed, then trigger a reindex of
     * stale files. The getAllFileHashes read + fs.stat loop + conditional reindex
     * all execute in the indexing worker thread, keeping the main thread unblocked.
     * Called by the registry during acquire(); not intended for direct use.
     */
    initWithLaunchDiff(): Promise<void>;
    /**
     * Receives individual file-change events from @parcel/watcher (which already
     * does OS-level coalescing at 50–500ms). Accumulates paths in pendingEvents
     * and schedules a drain after 300ms of silence — handles editor atomic-save
     * sequences where multiple writes arrive in rapid succession.
     */
    receiveWatcherEvent(filePath: string): void;
    /** Flush all accumulated paths as a single batch and clear the map. */
    private drainPendingEvents;
    /**
     * Debounced reindex with a 3-second window. Multiple rapid calls within
     * the window are coalesced into a single triggerReindex() at the end.
     */
    private debouncedReindex;
    /**
     * Called when specific files change (via drainPendingEvents or direct callers).
     * Always triggers a debounced reindex regardless of batch size — the indexing
     * pipeline handles batch sizing correctly, and polling can only see existing-in-DB
     * paths (it would silently drop new files in a large batch).
     */
    onFileChange(relativePaths: string[]): void;
    /**
     * Called after a git commit (e.g., from the hooks server). Git commits
     * often touch many files, so we debounce rather than reindex immediately.
     */
    onGitCommit(): void;
    /**
     * Called when a Claude Code session starts. Triggers an immediate reindex
     * (no debounce) to ensure the graph is fresh before the session queries it.
     */
    onSessionStart(): void;
    /**
     * Called when the workspace switches to a different project root.
     * Stops watching the old workspace, updates paths, and starts fresh.
     */
    onWorkspaceSwitch(newProjectRoot: string, newProjectName: string): void;
    /** Returns true if an incremental reindex is currently in progress. */
    isReindexing(): boolean;
    /** Returns the adaptive reconciliation interval in milliseconds. */
    getPollInterval(): number;
}
//# sourceMappingURL=autoSync.d.ts.map
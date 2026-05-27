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

import fs from 'fs/promises';
import path from 'path';

import type { Logger } from './loggerInterface';
import { consoleErrorLogger } from './loggerInterface';
import type { GraphDatabase } from './graphDatabase';
import type { IndexingPipeline } from './indexingPipeline';
import type { IndexingWorkerClient } from './indexingWorkerClient';

// ─── Options ──────────────────────────────────────────────────────────────────

export interface AutoSyncOptions {
  projectRoot: string;
  projectName: string;
  db: GraphDatabase;
  pipeline: IndexingPipeline;
  /** The indexing worker client — injected rather than fetched from a singleton. */
  workerClient: IndexingWorkerClient;
  /** Logger instance. Defaults to consoleErrorLogger. */
  logger?: Logger;
  onReindexComplete?: (result: { filesChanged: number; durationMs: number }) => void;
  onError?: (error: Error) => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum files to check per poll cycle to avoid blocking the event loop. */
const MAX_FILES_PER_POLL = 100;

/** Application-layer idle debounce on top of @parcel/watcher OS coalescing (ms). */
const APP_DEBOUNCE_MS = 300;

/** Legacy 3s debounce for git commits and explicit triggers. */
const DEBOUNCE_MS = 3000;

/** Log every Nth quiet poll cycle even when nothing changed (diagnostic heartbeat). */
const POLL_LOG_EVERY_N = 10;

/** Log the poll line if it took longer than this, even when nothing changed (ms). */
const POLL_LOG_SLOW_MS = 100;

// ─── Module-scope helpers ─────────────────────────────────────────────────────

/**
 * Async map with a bounded concurrency window.
 * Runs at most `concurrency` promises simultaneously; returns results in
 * input order. Items beyond the window are queued and started as slots free.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      // eslint-disable-next-line security/detect-object-injection -- idx is a bounded integer counter, not user input
      results[idx] = await fn(items[idx]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

// ─── AutoSyncWatcher ──────────────────────────────────────────────────────────

export class AutoSyncWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private appDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;
  private reindexing = false;
  private reconcileIntervalMs: number;

  /** Rolling offset into the file-hash catalog for the current scan window. */
  private scanOffset = 0;

  /** Counter incremented on every poll; used for periodic heartbeat logging. */
  private pollCount = 0;

  /** Accumulates file paths during the 300ms app-layer debounce window (OS-level coalescing + app idle gap). */
  private pendingEvents: Map<string, number> = new Map();

  /**
   * Snapshot of watcher-reported absolute paths carried from drainPendingEvents
   * through the 3s DEBOUNCE_MS window to triggerReindex. Passed as changedPaths
   * hint to skip the O(N_all_files) filterChangedFiles scan. Cleared on consume.
   */
  private watcherHintPaths: string[] = [];

  private opts: AutoSyncOptions;
  private logger: Logger;

  constructor(opts: AutoSyncOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? consoleErrorLogger;
    this.reconcileIntervalMs = AutoSyncWatcher.adaptivePollInterval(
      opts.db.getNodeCount(opts.projectName),
    );
  }

  /** Compute reconciliation cadence from node count. Polling is the safety net; watcher events are the hot path. */
  private static adaptivePollInterval(nodeCount: number): number {
    if (nodeCount < 2_000) return 60_000; // 1 min — reconciliation cadence
    if (nodeCount < 5_000) return 120_000; // 2 min
    if (nodeCount < 20_000) return 300_000; // 5 min
    return 600_000; // 10 min — very large repos
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Begin the polling timer loop. No-op if already running or disposed. */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.schedulePoll();
  }

  /** Stop the polling timer. Safe to call multiple times. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.appDebounceTimer) {
      clearTimeout(this.appDebounceTimer);
      this.appDebounceTimer = null;
    }
  }

  /** Stop polling and mark as permanently disposed. */
  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  // ─── Polling loop ─────────────────────────────────────────────────────────

  private schedulePoll(): void {
    if (!this.running || this.disposed) return;

    this.timer = setTimeout(async () => {
      try {
        await this.pollForChanges();
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
      this.schedulePoll();
    }, this.reconcileIntervalMs);
  }

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
  async pollForChanges(): Promise<void> {
    if (this.disposed || this.reindexing) return;
    const t0 = Date.now();
    this.pollCount++;

    const { changed, totalHashes } = await this.collectChangedFiles();

    const elapsedMs = Date.now() - t0;
    const shouldLog =
      changed.length > 0 || this.pollCount % POLL_LOG_EVERY_N === 0 || elapsedMs > POLL_LOG_SLOW_MS;

    if (shouldLog) {
      this.logger.info(
        `[trace:autoSync.poll] collectChangedFiles in ${elapsedMs}ms hashes=${totalHashes} changed=${changed.length}`,
      );
    }

    if (changed.length > 0) {
      await this.triggerReindex();
    }
  }

  /**
   * Collect files that have changed based on stat comparison.
   * Reads the full hash catalog once, slices MAX_FILES_PER_POLL records
   * starting at scanOffset, stats them concurrently (concurrency=32), then
   * advances scanOffset (wrapping at catalog length).
   *
   * Returns changed paths and the full catalog size for diagnostics.
   */
  private async collectChangedFiles(): Promise<{ changed: string[]; totalHashes: number }> {
    let allHashes: ReturnType<GraphDatabase['getAllFileHashes']>;

    try {
      allHashes = this.opts.db.getAllFileHashes(this.opts.projectName);
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      return { changed: [], totalHashes: 0 };
    }

    const totalHashes = allHashes.length;
    if (totalHashes === 0) return { changed: [], totalHashes };

    const slice = allHashes.slice(this.scanOffset, this.scanOffset + MAX_FILES_PER_POLL);
    this.scanOffset =
      this.scanOffset + MAX_FILES_PER_POLL >= totalHashes
        ? 0
        : this.scanOffset + MAX_FILES_PER_POLL;

    const results = await mapWithConcurrency(slice, 32, (record) => {
      const absolutePath = path.join(this.opts.projectRoot, record.rel_path);
      return this.checkFileChanged(absolutePath, record);
    });

    const changed = results.filter((r): r is string => r !== null);
    return { changed, totalHashes };
  }

  /**
   * Check a single file's stat against the stored hash record.
   * Returns the rel_path if changed/deleted, or null if unchanged.
   */
  private async checkFileChanged(
    absolutePath: string,
    record: ReturnType<GraphDatabase['getAllFileHashes']>[number],
  ): Promise<string | null> {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- absolutePath from trusted graph record
      const stat = await fs.stat(absolutePath);
      const currentMtimeNs = Math.floor(stat.mtimeMs * 1e6);
      const currentSize = stat.size;
      if (currentMtimeNs !== record.mtime_ns || currentSize !== record.size) {
        return record.rel_path;
      }
      return null;
    } catch {
      // File deleted or inaccessible -- mark as changed so reindex handles removal
      return record.rel_path;
    }
  }

  // ─── Reindex triggers ─────────────────────────────────────────────────────

  /**
   * Run pipeline.index() with incremental=true. Guarded by the reindexing
   * flag to prevent concurrent runs. Errors are caught and forwarded to onError.
   */
  private handleReindexResult(
    result: Awaited<ReturnType<IndexingWorkerClient['runIndex']>>,
    startTime: number,
  ): void {
    this.logger.info(
      `[trace:autoSync.reindex] done in ${Date.now() - startTime}ms success=${result.success} files=${result.filesIndexed} nodes=${result.nodesCreated} errors=${result.errors.length}`,
    );
    if (!result.success && result.errors.length > 0) {
      this.logger.warn(`[trace:autoSync.reindex] errors: ${result.errors.slice(0, 3).join('; ')}`);
    }
    if (result.success && result.filesIndexed > 0) {
      this.opts.onReindexComplete?.({
        filesChanged: result.filesIndexed,
        durationMs: Date.now() - startTime,
      });
    }
  }

  async triggerReindex(): Promise<void> {
    if (this.disposed || this.reindexing) return;

    this.logger.info(
      `[trace:autoSync.triggerReindex] pendingEventsSize=${this.pendingEvents.size} reindexing=${this.reindexing} hintPaths=${this.watcherHintPaths.length}`,
    );

    this.reindexing = true;
    const startTime = Date.now();
    this.logger.info(`[trace:autoSync.reindex] start root=${this.opts.projectRoot}`);

    // Consume the watcher hint paths and clear so the next run starts fresh.
    const changedPaths = this.watcherHintPaths.length > 0 ? [...this.watcherHintPaths] : undefined;
    this.watcherHintPaths = [];

    try {
      // Route through the injected IndexingWorkerClient so reindex runs
      // on the dedicated worker thread (avoids SQLite WAL lock contention).
      const result = await this.opts.workerClient.runIndex({
        projectRoot: this.opts.projectRoot,
        projectName: this.opts.projectName,
        incremental: true,
        changedPaths,
      });
      this.handleReindexResult(result, startTime);
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.reindexing = false;
    }
  }

  // ─── Launch diff ──────────────────────────────────────────────────────────

  /**
   * Run init: perform a launch-time catalog diff off the main thread to catch
   * changes that happened while the IDE was closed, then trigger a reindex of
   * stale files. The getAllFileHashes read + fs.stat loop + conditional reindex
   * all execute in the indexing worker thread, keeping the main thread unblocked.
   * Called by the registry during acquire(); not intended for direct use.
   */
  async initWithLaunchDiff(): Promise<void> {
    if (this.disposed) return;
    const t0 = Date.now();
    this.logger.info(
      '[trace:autoSync.initWithLaunchDiff] dispatching to worker root=%s',
      this.opts.projectRoot,
    );
    try {
      const result = await this.opts.workerClient.runLaunchDiff({
        projectRoot: this.opts.projectRoot,
        projectName: this.opts.projectName,
      });
      this.logger.info(
        '[trace:autoSync.initWithLaunchDiff] done elapsed=%dms stale=%d',
        Date.now() - t0,
        result.staleCount,
      );
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ─── Application-layer debounce (300ms) ───────────────────────────────────

  /**
   * Receives individual file-change events from @parcel/watcher (which already
   * does OS-level coalescing at 50–500ms). Accumulates paths in pendingEvents
   * and schedules a drain after 300ms of silence — handles editor atomic-save
   * sequences where multiple writes arrive in rapid succession.
   */
  receiveWatcherEvent(filePath: string): void {
    if (this.disposed) return;

    const current = this.pendingEvents.get(filePath) ?? 0;
    this.pendingEvents.set(filePath, current + 1);

    if (this.appDebounceTimer) clearTimeout(this.appDebounceTimer);
    this.appDebounceTimer = setTimeout(() => this.drainPendingEvents(), APP_DEBOUNCE_MS);
  }

  /** Flush all accumulated paths as a single batch and clear the map. */
  private drainPendingEvents(): void {
    this.appDebounceTimer = null;
    if (this.disposed || this.pendingEvents.size === 0) return;

    const paths = Array.from(this.pendingEvents.keys());
    this.pendingEvents.clear();
    // Accumulate hint paths; merge across drain-cycles within the same debounce window.
    this.watcherHintPaths = [...new Set([...this.watcherHintPaths, ...paths])];
    this.onFileChange(paths);
  }

  // ─── Debouncing ───────────────────────────────────────────────────────────

  /**
   * Debounced reindex with a 3-second window. Multiple rapid calls within
   * the window are coalesced into a single triggerReindex() at the end.
   */
  private debouncedReindex(): void {
    if (this.disposed) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.triggerReindex();
    }, DEBOUNCE_MS);
  }

  // ─── Event handlers (public, for integration) ─────────────────────────────

  /**
   * Called when specific files change (via drainPendingEvents or direct callers).
   * Always triggers a debounced reindex regardless of batch size — the indexing
   * pipeline handles batch sizing correctly, and polling can only see existing-in-DB
   * paths (it would silently drop new files in a large batch).
   */
  onFileChange(relativePaths: string[]): void {
    if (this.disposed || relativePaths.length === 0) return;
    this.debouncedReindex();
  }

  /**
   * Called after a git commit (e.g., from the hooks server). Git commits
   * often touch many files, so we debounce rather than reindex immediately.
   */
  onGitCommit(): void {
    if (this.disposed) return;
    this.debouncedReindex();
  }

  /**
   * Called when a Claude Code session starts. Triggers an immediate reindex
   * (no debounce) to ensure the graph is fresh before the session queries it.
   */
  onSessionStart(): void {
    if (this.disposed) return;
    this.triggerReindex();
  }

  /**
   * Called when the workspace switches to a different project root.
   * Stops watching the old workspace, updates paths, and starts fresh.
   */
  onWorkspaceSwitch(newProjectRoot: string, newProjectName: string): void {
    if (this.disposed) return;

    this.stop();
    this.opts.projectRoot = newProjectRoot;
    this.opts.projectName = newProjectName;

    // Recalculate reconciliation interval for the new project
    this.reconcileIntervalMs = AutoSyncWatcher.adaptivePollInterval(
      this.opts.db.getNodeCount(newProjectName),
    );

    this.start();
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  /** Returns true if an incremental reindex is currently in progress. */
  isReindexing(): boolean {
    return this.reindexing;
  }

  /** Returns the adaptive reconciliation interval in milliseconds. */
  getPollInterval(): number {
    return this.reconcileIntervalMs;
  }
}

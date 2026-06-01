/**
 * systemTwoRegistry.ts — Ref-counted per-root registry for System 2.
 *
 * System 2 uses a single global SQLite DB partitioned by project column.
 * This registry manages one AutoSyncWatcher per project root, coordinating
 * lifecycle (acquire / release) without owning the shared DB connection.
 */
import type { GraphDatabase } from './graphDatabase';
import type { IndexingPipeline } from './indexingPipeline';
import type { IndexingWorkerClient } from './indexingWorkerClient';
import type { SystemTwoHandle } from './systemTwoRegistryTypes';
/**
 * Normalize a project root to a stable Map key.
 * - Windows: lower-case (case-insensitive FS) + forward slashes
 * - macOS/Linux: forward slashes only (case-sensitive)
 */
export declare function normalizeRoot(input: string): string;
/**
 * Acquire a handle for the given project root.
 * Creates an AutoSyncWatcher on first acquire; increments refCount on repeat.
 * The watcher runs onLaunchDiff then starts polling.
 */
export declare function acquire(projectRoot: string, db: GraphDatabase, pipeline: IndexingPipeline, workerClient: IndexingWorkerClient): Promise<SystemTwoHandle>;
/**
 * Release a previously acquired root.
 * Decrements refCount. Disposes the watcher and removes the entry when count
 * reaches zero. Does NOT close the shared GraphDatabase.
 *
 * The native watcher subscription is closed fire-and-forget (not awaited) so
 * the Windows ReadDirectoryChangesW drain (~12s under load) does not block the
 * main-process event loop. The AutoSyncWatcher.disposed flag is set first via
 * watcher.dispose(), so any events that arrive from the still-draining native
 * subscription short-circuit in receiveWatcherEvent and are harmless.
 */
export declare function release(projectRoot: string): void;
/** Read-only lookup. Returns null if root is not registered. */
export declare function getHandle(projectRoot: string): SystemTwoHandle | null;
/** List all active (refCount > 0) handles — for observability. */
export declare function listActive(): SystemTwoHandle[];
/**
 * Dispose all watchers and clear the registry. Call on app shutdown.
 *
 * On app shutdown the OS reclaims all file handles on process exit, so the
 * native close can be fire-and-forget here too — we don't need to await the
 * ReadDirectoryChangesW drain. Keeping it synchronous from the caller's
 * perspective avoids holding up the shutdown sequence.
 */
export declare function disposeAll(): void;
//# sourceMappingURL=systemTwoRegistry.d.ts.map
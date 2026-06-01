/**
 * systemTwoRegistry.ts — Ref-counted per-root registry for System 2.
 *
 * System 2 uses a single global SQLite DB partitioned by project column.
 * This registry manages one AutoSyncWatcher per project root, coordinating
 * lifecycle (acquire / release) without owning the shared DB connection.
 */
import path from 'path';
import watcher from '@parcel/watcher';
import { consoleErrorLogger as log } from './loggerInterface.js';
import { AutoSyncWatcher } from './autoSync.js';
/**
 * Mirrors `WATCHER_IGNORE_GLOBS` in `src/main/ipc-handlers/files.ts` —
 * keep these in sync. Skips dotfiles, VCS, and common build outputs so
 * the indexer doesn't churn on `out/`, `dist/`, `node_modules/`, etc.
 */
const AUTOSYNC_WATCHER_IGNORE_GLOBS = [
    '**/.*/**',
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/out/**',
    '**/build/**',
    '**/coverage/**',
];
// ─── Module-level state ───────────────────────────────────────────────────────
const registry = new Map();
// ─── Path normalization ───────────────────────────────────────────────────────
/**
 * Normalize a project root to a stable Map key.
 * - Windows: lower-case (case-insensitive FS) + forward slashes
 * - macOS/Linux: forward slashes only (case-sensitive)
 */
export function normalizeRoot(input) {
    const resolved = path.resolve(input).replace(/\\/g, '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
// ─── Handle projection ────────────────────────────────────────────────────────
function toHandle(entry) {
    return {
        projectRoot: entry.projectRoot,
        projectName: entry.projectName,
        refCount: entry.refCount,
        watcher: entry.watcher,
        createdAt: entry.createdAt,
        lastIndexStatus: entry.lastIndexStatus,
    };
}
function buildWatcherOpts({ projectRoot, projectName, db, pipeline, workerClient, entry, }) {
    return {
        projectRoot,
        projectName,
        db,
        pipeline,
        workerClient,
        onReindexComplete: (result) => {
            entry.lastIndexStatus = `complete:${result.filesChanged}files:${result.durationMs}ms`;
            log.info(`[s2-registry] reindex complete for ${projectName}`, result);
        },
        onError: (err) => {
            entry.lastIndexStatus = `error:${err.message}`;
            log.warn(`[s2-registry] watcher error for ${projectName}:`, err);
        },
    };
}
// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Acquire a handle for the given project root.
 * Creates an AutoSyncWatcher on first acquire; increments refCount on repeat.
 * The watcher runs onLaunchDiff then starts polling.
 */
export async function acquire(projectRoot, db, pipeline, workerClient) {
    const key = normalizeRoot(projectRoot);
    const existing = registry.get(key);
    if (existing) {
        existing.refCount++;
        log.info(`[s2-registry] acquire (refCount=${existing.refCount}) ${existing.projectName}`);
        return toHandle(existing);
    }
    const projectName = path.basename(path.resolve(projectRoot));
    const entry = {
        projectRoot: path.resolve(projectRoot).replace(/\\/g, '/'),
        projectName,
        refCount: 1,
        watcher: null,
        nativeWatcherSubscription: null,
        createdAt: Date.now(),
        lastIndexStatus: 'initializing',
    };
    registry.set(key, entry);
    const opts = buildWatcherOpts({ projectRoot, projectName, db, pipeline, workerClient, entry });
    const watcher = new AutoSyncWatcher(opts);
    entry.watcher = watcher;
    await watcher.initWithLaunchDiff();
    watcher.start();
    // Wave 53k follow-up (H3): wire @parcel/watcher into AutoSyncWatcher.
    // Pre-fix `receiveWatcherEvent` had zero callers; new-file creation was
    // invisible to the poll loop because `collectChangedFiles` only iterates
    // existing-in-DB hashes. Native events catch creation, modification, and
    // deletion within the OS-level coalescing window.
    entry.nativeWatcherSubscription = await subscribeNativeWatcher(projectRoot, watcher);
    entry.lastIndexStatus = 'running';
    log.info(`[s2-registry] acquired (new) ${projectName}`);
    return toHandle(entry);
}
/**
 * Platform-appropriate backend for @parcel/watcher. Avoids the default-branch
 * watchman probe on Windows, which prints a shell warning about unrecognized
 * command. Mirrors the same logic in the Electron IDE's nativeWatcher.ts.
 */
function parcelBackend() {
    switch (process.platform) {
        case 'win32':
            return 'windows';
        case 'darwin':
            return 'fs-events';
        case 'linux':
            return 'inotify';
        default:
            return 'brute-force';
    }
}
async function subscribeNativeWatcher(projectRoot, autoSyncWatcher) {
    try {
        const sub = await watcher.subscribe(projectRoot, (err, events) => {
            if (err) {
                log.warn(`[s2-registry] watcher error for ${projectRoot}:`, err);
                return;
            }
            for (const e of events) {
                autoSyncWatcher.receiveWatcherEvent(e.path);
            }
        }, { backend: parcelBackend(), ignore: AUTOSYNC_WATCHER_IGNORE_GLOBS });
        return { close: async () => sub.unsubscribe() };
    }
    catch (err) {
        // Native watcher subscription is best-effort — autoSync degrades to
        // poll-only if the OS-level subscription fails (e.g., permissions,
        // unsupported FS). Log and continue without throwing.
        log.warn(`[s2-registry] native watcher subscribe failed for ${projectRoot}:`, err);
        return null;
    }
}
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
export function release(projectRoot) {
    const key = normalizeRoot(projectRoot);
    const entry = registry.get(key);
    if (!entry)
        return;
    entry.refCount--;
    log.info(`[s2-registry] release (refCount=${entry.refCount}) ${entry.projectName}`);
    if (entry.refCount <= 0) {
        // Snapshot the subscription and clear it on the entry BEFORE the async
        // close fires, so a concurrent release() call for the same root won't
        // see a live subscription and attempt a double-close.
        const sub = entry.nativeWatcherSubscription;
        entry.nativeWatcherSubscription = null;
        // Dispose the watcher first — sets AutoSyncWatcher.disposed = true so
        // incoming events from the still-draining native subscription short-circuit.
        entry.watcher?.dispose();
        // Remove the entry synchronously before kicking off the async close so
        // no concurrent acquire/release can observe this dying entry.
        registry.delete(key);
        log.info(`[s2-registry] disposed ${entry.projectName}`);
        closeNativeSubscriptionFireAndForget(sub, entry.projectName);
    }
}
/**
 * Kick off the native subscription close without awaiting it. On Windows,
 * ReadDirectoryChangesW drain can take 10–13 s under load; awaiting it on the
 * window-closed path stalls the main-process event loop. Fire-and-forget is
 * safe because the AutoSyncWatcher.disposed flag is already set before this
 * call, so any events that arrive while the native subscription is draining
 * short-circuit in receiveWatcherEvent.
 */
function closeNativeSubscriptionFireAndForget(sub, projectName) {
    if (!sub)
        return;
    sub.close().catch((err) => {
        log.warn(`[s2-registry] native watcher close failed for ${projectName}:`, err);
    });
}
/** Read-only lookup. Returns null if root is not registered. */
export function getHandle(projectRoot) {
    const entry = registry.get(normalizeRoot(projectRoot));
    return entry ? toHandle(entry) : null;
}
/** List all active (refCount > 0) handles — for observability. */
export function listActive() {
    return Array.from(registry.values()).map(toHandle);
}
/**
 * Dispose all watchers and clear the registry. Call on app shutdown.
 *
 * On app shutdown the OS reclaims all file handles on process exit, so the
 * native close can be fire-and-forget here too — we don't need to await the
 * ReadDirectoryChangesW drain. Keeping it synchronous from the caller's
 * perspective avoids holding up the shutdown sequence.
 */
export function disposeAll() {
    const entries = Array.from(registry.values());
    for (const entry of entries) {
        const sub = entry.nativeWatcherSubscription;
        entry.nativeWatcherSubscription = null;
        entry.watcher?.dispose();
        closeNativeSubscriptionFireAndForget(sub, entry.projectName);
    }
    registry.clear();
    log.info('[s2-registry] disposeAll complete');
}
//# sourceMappingURL=systemTwoRegistry.js.map
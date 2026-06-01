/**
 * indexingWorker.ts — Worker-thread entry point for the System 2 indexing pipeline.
 *
 * Opens its own GraphDatabase connection (WAL allows multiple independent
 * connections to the same file), constructs an IndexingPipeline, and processes
 * indexRepository requests one at a time via parentPort messaging.
 *
 * NOTE: Normally invoked via indexingWorkerClient — not imported directly by
 * main-process code.  The class is still directly usable for tests.
 */
import fs from 'fs/promises';
import path from 'path';
import { parentPort, workerData } from 'worker_threads';
import { consoleErrorLogger as log } from './loggerInterface.js';
import { mapConcurrent } from './concurrency.js';
import { GraphDatabase } from './graphDatabase.js';
import { IndexingPipeline } from './indexingPipeline.js';
import { TreeSitterParser } from './treeSitterParser.js';
// ── Worker-local singletons ───────────────────────────────────────────────────
let db = null;
let parser = null;
let pipeline = null;
let disposed = false;
/**
 * Resolve the SQLite path the worker should open. Wave 53k follow-up
 * (H1): main thread passes its resolved `getDbPath()` via workerData
 * because `require('electron').app.getPath('userData')` from a worker
 * thread returns an unready/empty path on Electron — pre-fix the worker
 * fell back to `process.cwd()` and wrote to a separate db file from the
 * main thread, so file_hashes never reached the autoSync poll's view.
 */
function resolveWorkerDbPath() {
    const data = workerData;
    return data?.dbPath;
}
async function getOrInitPipeline() {
    if (pipeline)
        return pipeline;
    db = new GraphDatabase(resolveWorkerDbPath());
    parser = new TreeSitterParser();
    await parser.init();
    pipeline = new IndexingPipeline(db, parser);
    return pipeline;
}
function disposeResources() {
    try {
        parser?.dispose();
    }
    catch {
        /* parser cleanup best-effort */
    }
    try {
        db?.close();
    }
    catch {
        /* db close best-effort */
    }
    parser = null;
    db = null;
    pipeline = null;
}
// ── Messaging helpers ─────────────────────────────────────────────────────────
function post(msg) {
    parentPort?.postMessage(msg);
}
// ── Request handler ───────────────────────────────────────────────────────────
async function handleIndexRepository(req) {
    if (disposed) {
        post({ type: 'error', requestId: req.requestId, message: 'Worker is disposed' });
        return;
    }
    const pl = await getOrInitPipeline();
    const onProgress = (progress) => {
        post({ type: 'progress', requestId: req.requestId, progress });
    };
    const result = await pl.index({ ...req.options, onProgress });
    post({ type: 'result', requestId: req.requestId, result });
}
function handleDispose(req) {
    disposed = true;
    disposeResources();
    post({ type: 'disposed', requestId: req.requestId });
    // Exit on next tick so the ack message flushes before the worker thread dies.
    setImmediate(() => process.exit(0));
}
async function statFileRecord(projectRoot, record) {
    const absolutePath = path.join(projectRoot, record.rel_path);
    try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- absolutePath from trusted graph record
        const stat = await fs.stat(absolutePath);
        const mtimeNs = Math.floor(stat.mtimeMs * 1e6);
        const status = mtimeNs !== record.mtime_ns || stat.size !== record.size ? 'stale' : 'ok';
        return { relPath: record.rel_path, absolutePath, status };
    }
    catch {
        return { relPath: record.rel_path, absolutePath, status: 'deleted' };
    }
}
async function runDiff(projectRoot, projectName) {
    const hashes = db?.getAllFileHashes(projectName) ?? [];
    const statResults = await mapConcurrent(hashes, (record) => statFileRecord(projectRoot, record));
    return {
        stale: statResults.filter((r) => r.status === 'stale'),
        deleted: statResults.filter((r) => r.status === 'deleted'),
    };
}
async function handleLaunchDiff(req) {
    if (disposed) {
        post({ type: 'error', requestId: req.requestId, message: 'Worker is disposed' });
        return;
    }
    const t0 = Date.now();
    const { projectRoot, projectName } = req;
    log.info('[trace:worker.launchDiff] start projectName=%s', projectName);
    const pl = await getOrInitPipeline();
    const { stale, deleted } = await runDiff(projectRoot, projectName);
    log.info('[trace:worker.launchDiff] hashes=%d changed=%d deleted=%d elapsed=%dms', stale.length + deleted.length, stale.length, deleted.length, Date.now() - t0);
    let reindexed = false;
    if (stale.length > 0 || deleted.length > 0) {
        log.info('[trace:worker.launchDiff] reindex triggered changedPaths=%d', stale.length);
        await pl.index({
            projectRoot,
            projectName,
            incremental: true,
            changedPaths: stale.map((r) => r.absolutePath),
        });
        reindexed = true;
    }
    post({
        type: 'launchDiffResult',
        requestId: req.requestId,
        result: {
            staleCount: stale.length,
            deletedCount: deleted.length,
            reindexed,
            durationMs: Date.now() - t0,
        },
    });
}
async function handleMessage(msg) {
    try {
        switch (msg.type) {
            case 'indexRepository':
                await handleIndexRepository(msg);
                break;
            case 'launchDiff':
                await handleLaunchDiff(msg);
                break;
            case 'dispose':
                handleDispose(msg);
                break;
            default: {
                const unknownMsg = msg;
                post({
                    type: 'error',
                    requestId: unknownMsg.requestId,
                    message: `Unknown request type: ${String(unknownMsg.type)}`,
                });
            }
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        post({ type: 'error', requestId: msg.requestId, message, stack });
    }
}
// ── Bootstrap ─────────────────────────────────────────────────────────────────
parentPort?.on('message', (msg) => {
    void handleMessage(msg);
});
//# sourceMappingURL=indexingWorker.js.map
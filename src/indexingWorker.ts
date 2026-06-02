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
import fsSync from 'fs';
import path from 'path';
import { parentPort, workerData } from 'worker_threads';

import { consoleErrorLogger as log } from './loggerInterface';
import { mapConcurrent } from './concurrency';
import { GraphDatabase } from './graphDatabase';
import { IndexingPipeline } from './indexingPipeline';
import type { IndexingProgress } from './indexingPipelineTypes';
import type {
  DisposeRequest,
  IndexingWorkerRequest,
  IndexingWorkerResponse,
  IndexRepositoryRequest,
  LaunchDiffRequest,
} from './indexingWorkerTypes';
import { TreeSitterParser } from './treeSitterParser';
import { Project } from 'ts-morph';

// ── Worker-local singletons ───────────────────────────────────────────────────

let db: GraphDatabase | null = null;
let parser: TreeSitterParser | null = null;
let pipeline: IndexingPipeline | null = null;
let disposed = false;

// ── ts-morph Project singleton (D2 + D4) ─────────────────────────────────────

/** Cached ts-morph Project instance. Created at most once per worker lifetime. */
let tsMorphProject: Project | null = null;
/**
 * Set to true if the ts-morph Project constructor threw on first call.
 * Prevents retry on subsequent incremental runs (D4).
 */
let tsMorphProjectFailed = false;
/**
 * Set to true if no tsconfig.json exists at projectRoot — non-TS project.
 * Terminal condition for worker lifetime, distinct from constructor failure (D4).
 */
let tsMorphProjectUnavailable = false;

/**
 * Return the worker-local ts-morph Project singleton, or null when:
 *   (a) skipTsEnrichment is set — CPU escape-valve (D3)
 *   (b) no tsconfig.json exists at projectRoot — non-TS project
 *   (c) a prior construction attempt threw — tsMorphProjectFailed guard (D4)
 *
 * On first real call, constructs `new Project({ tsConfigFilePath })` and
 * caches it. If the constructor throws: sets tsMorphProjectFailed, logs a
 * warning, and returns null without retrying on later runs.
 */
function getOrInitTsMorphProject(
  projectRoot: string,
  skipTsEnrichment?: boolean,
): Project | null {
  if (skipTsEnrichment) return null;
  if (tsMorphProjectFailed) return null;
  if (tsMorphProjectUnavailable) return null;
  if (tsMorphProject) return tsMorphProject;

  const tsConfigFilePath = path.join(projectRoot, 'tsconfig.json');
  // Check synchronously — fs.existsSync is fine in worker context and avoids
  // async complexity in what is otherwise a synchronous init path.
  // We use a try/catch on the constructor itself as the canonical guard (D4),
  // so a quick existence check here handles the common non-TS project case
  // without incurring constructor overhead.
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- projectRoot is trusted
    fsSync.accessSync(tsConfigFilePath);
  } catch {
    // No tsconfig.json — non-TS project, skip silently (D4)
    tsMorphProjectUnavailable = true;
    return null;
  }

  try {
    tsMorphProject = new Project({ tsConfigFilePath });
    log.info('[trace:worker.tsMorph] Project initialised tsconfig=%s', tsConfigFilePath);
    return tsMorphProject;
  } catch (err) {
    tsMorphProjectFailed = true;
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('[trace:worker.tsMorph] Project init failed — enrichment disabled: %s', msg);
    return null;
  }
}

/**
 * Resolve the SQLite path the worker should open. Wave 53k follow-up
 * (H1): main thread passes its resolved `getDbPath()` via workerData
 * because `require('electron').app.getPath('userData')` from a worker
 * thread returns an unready/empty path on Electron — pre-fix the worker
 * fell back to `process.cwd()` and wrote to a separate db file from the
 * main thread, so file_hashes never reached the autoSync poll's view.
 */
function resolveWorkerDbPath(): string | undefined {
  const data = workerData as { dbPath?: string } | null | undefined;
  return data?.dbPath;
}

async function getOrInitPipeline(): Promise<IndexingPipeline> {
  if (pipeline) return pipeline;
  db = new GraphDatabase(resolveWorkerDbPath());
  parser = new TreeSitterParser();
  await parser.init();
  pipeline = new IndexingPipeline(db, parser);
  return pipeline;
}

function disposeResources(): void {
  try {
    parser?.dispose();
  } catch {
    /* parser cleanup best-effort */
  }
  try {
    db?.close();
  } catch {
    /* db close best-effort */
  }
  parser = null;
  db = null;
  pipeline = null;
  // Release the ts-morph language-service heap on teardown (D2).
  tsMorphProject = null;
  tsMorphProjectFailed = false;
  tsMorphProjectUnavailable = false;
}

// ── Messaging helpers ─────────────────────────────────────────────────────────

function post(msg: IndexingWorkerResponse): void {
  parentPort?.postMessage(msg);
}

// ── Request handler ───────────────────────────────────────────────────────────

async function handleIndexRepository(req: IndexRepositoryRequest): Promise<void> {
  if (disposed) {
    post({ type: 'error', requestId: req.requestId, message: 'Worker is disposed' });
    return;
  }
  const pl = await getOrInitPipeline();

  const onProgress = (progress: IndexingProgress): void => {
    post({ type: 'progress', requestId: req.requestId, progress });
  };

  // Wire the ts-morph forget() seam: when a file is pruned from the graph,
  // release its AST from the language-service heap. (D7)
  const onFilePruned = (absolutePath: string): void => {
    const project = getOrInitTsMorphProject(req.options.projectRoot, req.options.skipTsEnrichment);
    project?.getSourceFile(absolutePath)?.forget();
  };

  const result = await pl.index({ ...req.options, onProgress, onFilePruned });
  post({ type: 'result', requestId: req.requestId, result });
}

function handleDispose(req: DisposeRequest): void {
  disposed = true;
  disposeResources();
  post({ type: 'disposed', requestId: req.requestId });
  // Exit on next tick so the ack message flushes before the worker thread dies.
  setImmediate(() => process.exit(0));
}

// ── Stat helper ───────────────────────────────────────────────────────────────

interface StatResult {
  relPath: string;
  absolutePath: string;
  status: 'stale' | 'deleted' | 'ok';
}

async function statFileRecord(
  projectRoot: string,
  record: { rel_path: string; mtime_ns: number; size: number },
): Promise<StatResult> {
  const absolutePath = path.join(projectRoot, record.rel_path);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- absolutePath from trusted graph record
    const stat = await fs.stat(absolutePath);
    const mtimeNs = Math.floor(stat.mtimeMs * 1e6);
    const status = mtimeNs !== record.mtime_ns || stat.size !== record.size ? 'stale' : 'ok';
    return { relPath: record.rel_path, absolutePath, status };
  } catch {
    return { relPath: record.rel_path, absolutePath, status: 'deleted' };
  }
}

interface DiffResult {
  stale: StatResult[];
  deleted: StatResult[];
}

async function runDiff(projectRoot: string, projectName: string): Promise<DiffResult> {
  const hashes = db?.getAllFileHashes(projectName) ?? [];
  const statResults = await mapConcurrent(hashes, (record) => statFileRecord(projectRoot, record));
  return {
    stale: statResults.filter((r) => r.status === 'stale'),
    deleted: statResults.filter((r) => r.status === 'deleted'),
  };
}

async function handleLaunchDiff(req: LaunchDiffRequest): Promise<void> {
  if (disposed) {
    post({ type: 'error', requestId: req.requestId, message: 'Worker is disposed' });
    return;
  }
  const t0 = Date.now();
  const { projectRoot, projectName } = req;
  log.info('[trace:worker.launchDiff] start projectName=%s', projectName);
  const pl = await getOrInitPipeline();

  const { stale, deleted } = await runDiff(projectRoot, projectName);
  log.info(
    '[trace:worker.launchDiff] hashes=%d changed=%d deleted=%d elapsed=%dms',
    stale.length + deleted.length,
    stale.length,
    deleted.length,
    Date.now() - t0,
  );

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

async function handleMessage(msg: IndexingWorkerRequest): Promise<void> {
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
        const unknownMsg = msg as IndexingWorkerRequest;
        post({
          type: 'error',
          requestId: unknownMsg.requestId,
          message: `Unknown request type: ${String(unknownMsg.type)}`,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    post({ type: 'error', requestId: msg.requestId, message, stack });
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

parentPort?.on('message', (msg: IndexingWorkerRequest) => {
  void handleMessage(msg);
});

/**
 * indexingPipelineIncremental.ts — File discovery and incremental reindex helpers.
 *
 * Extracted from indexingPipeline.ts to satisfy the 300-line file limit.
 * These are module-level helpers used by IndexingPipeline; they have no
 * dependency on the class itself and can be tested in isolation.
 */

import { consoleErrorLogger as log } from './loggerInterface';
import { mapConcurrent } from './concurrency';
import { GraphDatabase } from './graphDatabase';
import {
  hashFileContent,
  loadIgnoreRules,
  type WalkContext,
  walkDirectory,
} from './indexingPipelineSupport';
import type { DiscoveredFile, IndexingOptions } from './indexingPipelineTypes';

// ─── File Discovery (Pass 0) ─────────────────────────────────────────────────

export async function discoverFiles(
  projectRoot: string,
  options: IndexingOptions,
): Promise<DiscoveredFile[]> {
  const files: DiscoveredFile[] = [];
  const ig = await loadIgnoreRules(projectRoot, options.ignorePaths ?? []);
  const ctx: WalkContext = {
    projectRoot,
    ig,
    maxSize: options.maxFileSize ?? 512 * 1024,
    maxFiles: options.maxFiles ?? 10000,
    files,
  };
  await walkDirectory(projectRoot, ctx);
  return files;
}

// ─── Incremental Reindex Logic ────────────────────────────────────────────────

type FileTag =
  | { kind: 'unchanged-stat'; file: DiscoveredFile }
  | { kind: 'unchanged-hash'; file: DiscoveredFile; hash: string }
  | { kind: 'changed'; file: DiscoveredFile };

async function classifyFile(
  db: GraphDatabase,
  projectName: string,
  file: DiscoveredFile,
): Promise<FileTag> {
  const existing = db.getFileHash(projectName, file.relativePath);
  if (
    existing &&
    existing.mtime_ns === Math.floor(file.mtimeMs * 1e6) &&
    existing.size === file.sizeBytes
  ) {
    return { kind: 'unchanged-stat', file };
  }
  const hash = await hashFileContent(file.absolutePath);
  if (existing && existing.content_hash === hash) {
    return { kind: 'unchanged-hash', file, hash };
  }
  return { kind: 'changed', file };
}

export async function filterChangedFiles(
  db: GraphDatabase,
  projectName: string,
  files: DiscoveredFile[],
): Promise<{ changed: DiscoveredFile[]; unchanged: string[] }> {
  const t0fc = Date.now();
  log.info(`[trace:filterChangedFiles] start allFiles=${files.length} project=${projectName}`);

  const tags = await mapConcurrent(files, (file) => classifyFile(db, projectName, file));
  const changed: DiscoveredFile[] = [];
  const unchanged: string[] = [];

  for (const tag of tags) {
    if (tag.kind === 'unchanged-stat') {
      unchanged.push(tag.file.relativePath);
    } else if (tag.kind === 'unchanged-hash') {
      db.upsertFileHash({
        project: projectName,
        rel_path: tag.file.relativePath,
        content_hash: tag.hash,
        mtime_ns: Math.floor(tag.file.mtimeMs * 1e6),
        size: tag.file.sizeBytes,
      });
      unchanged.push(tag.file.relativePath);
    } else {
      changed.push(tag.file);
    }
  }

  log.info(
    `[trace:filterChangedFiles] done changed=${changed.length} elapsed=${Date.now() - t0fc}ms`,
  );
  return { changed, unchanged };
}

/**
 * Variant of filterChangedFiles that classifies only a targeted subset of
 * discovered files identified by their absolute paths. Used by the incremental
 * fast-path when the watcher has already narrowed the candidate set to specific
 * paths — avoids the O(N_all_files) scan when only a handful of files changed.
 *
 * Files in the hint set that are not present in allFiles (e.g. deleted since
 * discovery) are silently skipped — callers should handle deletions separately
 * via pruneDeletedFiles.
 */
export async function filterChangedFilesSubset(
  db: GraphDatabase,
  projectName: string,
  allFiles: DiscoveredFile[],
  candidatePaths: string[],
): Promise<{ changed: DiscoveredFile[]; unchanged: string[] }> {
  const pathSet = new Set(candidatePaths);
  const candidates = allFiles.filter((f) => pathSet.has(f.absolutePath));
  log.info(
    `[trace:filterChangedFiles] subset start candidates=${candidates.length} hints=${candidatePaths.length} project=${projectName}`,
  );
  return filterChangedFiles(db, projectName, candidates);
}

/** Options for resolveIncrementalFiles. */
export interface ResolveIncrementalOpts {
  db: GraphDatabase;
  projectName: string;
  allFiles: DiscoveredFile[];
  changedPaths?: string[];
  pruneDeleted: (allFiles: DiscoveredFile[]) => void;
  deleteNodes: (relativePath: string) => void;
}

/**
 * Core incremental-reindex resolution: selects which files to process,
 * classifying only the watcher-hinted subset when available (O(K))
 * or the full catalog otherwise (O(N)).
 *
 * Returns the files to process and whether this is a true incremental run.
 * Returns empty filesToProcess when changed=0, signalling a no-op fast-path.
 */
export async function resolveIncrementalFiles(
  opts: ResolveIncrementalOpts,
): Promise<{ filesToProcess: DiscoveredFile[]; isIncrementalRun: boolean }> {
  const { db, projectName, allFiles, changedPaths, pruneDeleted, deleteNodes } = opts;
  const classifier =
    changedPaths && changedPaths.length > 0
      ? filterChangedFilesSubset(db, projectName, allFiles, changedPaths)
      : filterChangedFiles(db, projectName, allFiles);

  const { changed } = await classifier;
  log.info(
    `[trace:pipeline.resolve] allFiles=${allFiles.length} changed=${changed.length} hint=${changedPaths?.length ?? 'none'}`,
  );
  const isIncrementalRun = changed.length < allFiles.length;

  if (changed.length === 0 && isIncrementalRun) {
    // Still prune deletions even when no files changed — a deletion-only
    // event (file removed, nothing else modified) lands here and without
    // this call the deleted file's nodes+edges persist forever.
    pruneDeleted(allFiles);
    return { filesToProcess: [], isIncrementalRun };
  }

  for (const file of changed) deleteNodes(file.relativePath);
  pruneDeleted(allFiles);
  return { filesToProcess: changed, isIncrementalRun };
}

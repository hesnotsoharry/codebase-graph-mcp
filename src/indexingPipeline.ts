/**
 * indexingPipeline.ts — Multi-pass project indexer.
 *
 * NOTE: Normally invoked via indexingWorkerClient (worker thread).
 * This class is still directly usable for tests and one-off scripting.
 *
 * Walks a project directory, parses every supported source file with tree-sitter,
 * and populates the SQLite property graph with nodes and edges. Supports incremental
 * reindexing via stat-based fast path + SHA-256 content hash verification.
 *
 * Pass sequence:
 *   0. File Discovery   — walk directory, respect ignores, apply size/count caps
 *   1. Structure Pass   — Project, Folder, File nodes + containment edges
 *   2. Parse Pass       — tree-sitter parse all files -> ParsedFileResult[]
 *   3. Definition Pass  — Function/Class/Interface/Type/Enum/Method/Route nodes
 *   4. Import Pass      — resolve imports, create IMPORTS edges + Package nodes
 *   5. Call Resolution  — resolve call expressions, create CALLS/ASYNC_CALLS edges
 *   6. Finalize         — update file hashes + project stats
 *
 * File discovery and incremental helpers live in indexingPipelineIncremental.ts.
 */

import path from 'path';

import { consoleErrorLogger as log } from './loggerInterface';
import { GraphDatabase } from './graphDatabase';
import { callResolutionPass } from './indexingPipelineCallResolution';
import { discoverFiles, resolveIncrementalFiles } from './indexingPipelineIncremental';
import { definitionPass, importPass, parsePass, structurePass } from './indexingPipelinePasses';
import { buildIndexResult, buildNoOpResult } from './indexingPipelineResult';
import type {
  DiscoveredFile,
  IndexedFile,
  IndexingOptions,
  IndexingProgress,
  IndexingResult,
} from './indexingPipelineTypes';
import { enrichmentPass } from './passes/enrichmentPass';
import { gitCoChangePass, prefetchGitCoChangeData } from './passes/gitCoChangePass';
import { httpLinkPass } from './passes/httpLinkPass';
import { testDetectPass } from './passes/testDetectPass';
import { TreeSitterParser } from './treeSitterParser';

// ─── Pipeline Orchestrator ────────────────────────────────────────────────────

export class IndexingPipeline {
  private db: GraphDatabase;
  private parser: TreeSitterParser;

  constructor(db: GraphDatabase, parser: TreeSitterParser) {
    this.db = db;
    this.parser = parser;
  }

  // Reports the phase, runs the thunk inside a single transaction, then yields
  // the event loop via setImmediate so IPC messages aren't starved between passes.
  // A pass that throws is logged and skipped; subsequent passes still run. The
  // failing pass's transaction is rolled back automatically by db.transaction.
  private async runPass(
    phase: string,
    thunk: () => void,
    report: (p: string) => void,
  ): Promise<void> {
    report(phase);
    try {
      this.db.transaction(thunk);
    } catch (err) {
      log.warn('[pipeline] pass=%s threw, isolating: %s', phase, err instanceof Error ? err.message : String(err));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  // Like runPass but does NOT add an outer transaction — used for chunked passes
  // that manage their own per-chunk transactions internally.
  private async runChunkedPass(
    phase: string,
    thunk: () => void,
    report: (p: string) => void,
    errorCounter?: { count: number },
  ): Promise<void> {
    report(phase);
    try {
      thunk();
    } catch (err) {
      log.warn('[pipeline] pass=%s threw, isolating: %s', phase, err instanceof Error ? err.message : String(err));
      if (errorCounter) errorCounter.count++;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  // Wraps a timed pass, recording elapsed ms into the timings map.
  private async withTiming(
    phase: string,
    fn: () => Promise<void>,
    timings: Record<string, number>,
  ): Promise<void> {
    const start = performance.now();
    await fn();
    Object.assign(timings, { [phase]: performance.now() - start });
  }

  private async runCorePasses(
    ctx: { projectName: string; projectRoot: string; indexedFiles: IndexedFile[]; structureFiles: DiscoveredFile[] },
    report: (p: string) => void,
    timings: Record<string, number>,
    errorCounter: { count: number },
  ): Promise<void> {
    const { projectName, projectRoot, indexedFiles, structureFiles } = ctx;
    const CHUNK = 500;
    await this.withTiming(
      'structure',
      () => this.runPass('structure', () => structurePass(this.db, projectName, projectRoot, structureFiles), report),
      timings,
    );
    await this.withTiming(
      'definitions',
      () => this.runChunkedPass('definitions', () => definitionPass(this.db, projectName, indexedFiles, { chunkSize: CHUNK }), report, errorCounter),
      timings,
    );
    await this.withTiming(
      'imports',
      () => this.runChunkedPass('imports', () => importPass(this.db, projectName, indexedFiles, { allFiles: structureFiles, chunkSize: CHUNK }), report, errorCounter),
      timings,
    );
    await this.withTiming(
      'calls',
      () => this.runChunkedPass('calls', () => callResolutionPass(this.db, projectName, indexedFiles, { chunkSize: CHUNK }), report, errorCounter),
      timings,
    );
  }

  private async runEnrichmentPasses(
    ctx: { projectName: string; indexedFiles: IndexedFile[]; gitCommitFiles: string[][] | null; isIncrementalRun: boolean },
    report: (p: string) => void,
    timings: Record<string, number>,
  ): Promise<void> {
    const { projectName, indexedFiles, gitCommitFiles, isIncrementalRun } = ctx;
    // undefined on full reindexes forces unconditional cache rebuild in testDetectPass.
    const changedFiles = isIncrementalRun
      ? new Set(indexedFiles.map((f) => f.relativePath))
      : undefined;
    await this.withTiming(
      'http_links',
      () => this.runPass('http_links', () => httpLinkPass(this.db, projectName, indexedFiles), report),
      timings,
    );
    await this.withTiming(
      'test_detection',
      () => this.runPass('test_detection', () => testDetectPass(this.db, projectName, indexedFiles, changedFiles), report),
      timings,
    );
    await this.withTiming(
      'enrichment',
      () => this.runPass('enrichment', () => enrichmentPass(this.db, projectName), report),
      timings,
    );
    await this.withTiming(
      'git_history',
      () => this.runPass('git_history', () => gitCoChangePass(this.db, projectName, gitCommitFiles), report),
      timings,
    );
  }

  private async runAllPasses(
    ctx: { projectName: string; projectRoot: string; errCount: { count: number }; isIncrementalRun: boolean },
    indexedFiles: IndexedFile[],
    structureFiles: DiscoveredFile[],
    report: (phase: string) => void,
  ): Promise<Record<string, number>> {
    const { projectName, projectRoot, errCount, isIncrementalRun } = ctx;
    const timings: Record<string, number> = {};

    // Pre-fetch async data before entering synchronous SQLite transactions.
    const gitStart = performance.now();
    report('git_prefetch');
    const gitCommitFiles = await prefetchGitCoChangeData(projectRoot);
    Object.assign(timings, { git_prefetch: performance.now() - gitStart });

    await this.runCorePasses({ projectName, projectRoot, indexedFiles, structureFiles }, report, timings, errCount);
    await this.runEnrichmentPasses({ projectName, indexedFiles, gitCommitFiles, isIncrementalRun }, report, timings);
    return timings;
  }

  private finalizeIndex(
    projectName: string,
    options: IndexingOptions,
    indexedFiles: IndexedFile[],
  ): { nodesCreated: number; edgesCreated: number } {
    for (const file of indexedFiles) {
      this.db.upsertFileHash({
        project: projectName,
        rel_path: file.relativePath,
        content_hash: file.contentHash,
        mtime_ns: Math.floor(file.mtimeMs * 1e6),
        size: file.sizeBytes,
      });
    }
    const nodesCreated = this.db.getNodeCount(projectName);
    const edgesCreated = this.db.getEdgeCount(projectName);
    this.db.upsertProject({
      name: projectName,
      root_path: options.projectRoot,
      indexed_at: Date.now(),
      node_count: nodesCreated,
      edge_count: edgesCreated,
    });
    return { nodesCreated, edgesCreated };
  }

  private async discoverAndResolve(
    options: IndexingOptions,
    projectName: string,
    progress: IndexingProgress,
  ): Promise<{
    allFiles: DiscoveredFile[];
    filesToProcess: DiscoveredFile[];
    isIncrementalRun: boolean;
  }> {
    const allFiles = await discoverFiles(options.projectRoot, options);
    progress.filesTotal = allFiles.length;
    const isIncremental = options.incremental !== false;
    const { filesToProcess, isIncrementalRun } = await this.resolveFilesToProcess(
      isIncremental, projectName, allFiles, options.changedPaths,
    );
    this.db.upsertProject({
      name: projectName,
      root_path: options.projectRoot,
      indexed_at: Date.now(),
      node_count: 0,
      edge_count: 0,
    });
    return { allFiles, filesToProcess, isIncrementalRun };
  }

  private async runIndex(
    options: IndexingOptions,
    projectName: string,
    report: (phase: string) => void,
    progress: IndexingProgress,
  ): Promise<IndexingResult> {
    const startTime = progress.startedAt;
    report('discovery');
    const { allFiles, filesToProcess, isIncrementalRun } = await this.discoverAndResolve(
      options,
      projectName,
      progress,
    );

    if (filesToProcess.length === 0 && isIncrementalRun) {
      log.info('[trace:pipeline.runIndex] no-op fast-path: 0 changed files, skipping all passes');
      return buildNoOpResult(projectName, allFiles, progress, startTime);
    }

    report('parsing');
    const indexedFiles = await parsePass(this.parser, filesToProcess, (processed) => {
      progress.filesProcessed = processed;
      report('parsing');
    });
    const structureFiles = isIncrementalRun ? filesToProcess : allFiles;
    const errCount = { count: 0 };
    const phaseTimingsMs = await this.runAllPasses({ projectName, projectRoot: options.projectRoot, errCount, isIncrementalRun }, indexedFiles, structureFiles, report);
    report('finalizing');
    const { nodesCreated, edgesCreated } = this.finalizeIndex(projectName, options, indexedFiles);
    return buildIndexResult({
      db: this.db, projectName, allFiles, filesToProcess, indexedFiles,
      nodesCreated, edgesCreated, phaseTimingsMs, passErrors: errCount.count, progress, isIncrementalRun, startTime,
    });
  }

  private buildIndexProgress(startTime: number, errors: string[]): IndexingProgress {
    return {
      phase: 'discovery',
      filesTotal: 0,
      filesProcessed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors,
      startedAt: startTime,
      elapsedMs: 0,
    };
  }

  async index(options: IndexingOptions): Promise<IndexingResult> {
    const startTime = Date.now();
    log.info(
      `[trace:pipeline.index] start incremental=${options.incremental ?? false} root=${options.projectRoot}`,
    );
    const errors: string[] = [];
    const projectName =
      options.projectName ??
      path
        .basename(options.projectRoot)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-');
    const progress = this.buildIndexProgress(startTime, errors);
    const report = (phase: string): void => {
      progress.phase = phase;
      progress.elapsedMs = Date.now() - startTime;
      progress.errors = errors;
      options.onProgress?.(progress);
    };

    try {
      const result = await this.runIndex(options, projectName, report, progress);
      log.info(
        `[trace:pipeline.index] done in ${Date.now() - startTime}ms incremental=${result.incremental} files=${result.filesIndexed}`,
      );
      return result;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return {
        projectName,
        success: false,
        filesIndexed: 0,
        filesSkipped: 0,
        nodesCreated: 0,
        edgesCreated: 0,
        errors,
        durationMs: Date.now() - startTime,
        incremental: false,
      };
    }
  }

  private pruneDeletedFiles(projectName: string, allFiles: DiscoveredFile[]): void {
    const diskPaths = new Set(allFiles.map((f) => f.relativePath));
    for (const hash of this.db.getAllFileHashes(projectName)) {
      if (!diskPaths.has(hash.rel_path)) {
        this.db.deleteNodesByFile(projectName, hash.rel_path);
        this.db.deleteFileHash(projectName, hash.rel_path);
      }
    }
  }

  private async resolveFilesToProcess(
    isIncremental: boolean,
    projectName: string,
    allFiles: DiscoveredFile[],
    changedPaths?: string[],
  ): Promise<{ filesToProcess: DiscoveredFile[]; isIncrementalRun: boolean }> {
    if (isIncremental && this.db.getProject(projectName)) {
      return resolveIncrementalFiles({
        db: this.db,
        projectName,
        allFiles,
        changedPaths,
        pruneDeleted: (files) => this.pruneDeletedFiles(projectName, files),
        deleteNodes: (rel) => this.db.deleteNodesByFile(projectName, rel),
      });
    }

    this.db.deleteProject(projectName);
    return { filesToProcess: allFiles, isIncrementalRun: false };
  }
}

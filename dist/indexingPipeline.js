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
import { consoleErrorLogger as log } from './loggerInterface.js';
import { callResolutionPass } from './indexingPipelineCallResolution.js';
import { discoverFiles, resolveIncrementalFiles } from './indexingPipelineIncremental.js';
import { definitionPass, importPass, parsePass, structurePass } from './indexingPipelinePasses.js';
import { typeofResolutionPass } from './indexingPipelineTypeofResolution.js';
import { buildIndexResult, buildNoOpResult } from './indexingPipelineResult.js';
import { enrichmentPass } from './passes/enrichmentPass.js';
import { gitCoChangePass, prefetchGitCoChangeData } from './passes/gitCoChangePass.js';
import { httpLinkPass } from './passes/httpLinkPass.js';
import { testDetectPass } from './passes/testDetectPass.js';
import { typescriptEnrichmentPass } from './passes/typescriptEnrichmentPass.js';
import { referencesPass } from './passes/referencesPass.js';
// ─── Pipeline Orchestrator ────────────────────────────────────────────────────
export class IndexingPipeline {
    db;
    parser;
    constructor(db, parser) {
        this.db = db;
        this.parser = parser;
    }
    // Reports the phase, runs the thunk inside a single transaction, then yields
    // the event loop via setImmediate so IPC messages aren't starved between passes.
    // A pass that throws is logged and skipped; subsequent passes still run. The
    // failing pass's transaction is rolled back automatically by db.transaction.
    async runPass(phase, thunk, report) {
        report(phase);
        try {
            this.db.transaction(thunk);
        }
        catch (err) {
            log.warn('[pipeline] pass=%s threw, isolating: %s', phase, err instanceof Error ? err.message : String(err));
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
    // Like runPass but does NOT add an outer transaction — used for chunked passes
    // that manage their own per-chunk transactions internally.
    async runChunkedPass(phase, thunk, report, errorCounter) {
        report(phase);
        try {
            thunk();
        }
        catch (err) {
            log.warn('[pipeline] pass=%s threw, isolating: %s', phase, err instanceof Error ? err.message : String(err));
            if (errorCounter)
                errorCounter.count++;
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
    // Wraps a timed pass, recording elapsed ms into the timings map.
    async withTiming(phase, fn, timings) {
        const start = performance.now();
        await fn();
        Object.assign(timings, { [phase]: performance.now() - start });
    }
    async runCorePasses(ctx, report, timings, errorCounter) {
        const { projectName, projectRoot, indexedFiles, structureFiles, tsMorphProject } = ctx;
        const CHUNK = 500;
        await this.withTiming('structure', () => this.runPass('structure', () => structurePass(this.db, projectName, projectRoot, structureFiles), report), timings);
        await this.withTiming('definitions', () => this.runChunkedPass('definitions', () => definitionPass(this.db, projectName, indexedFiles, { chunkSize: CHUNK }), report, errorCounter), timings);
        await this.withTiming('imports', () => this.runChunkedPass('imports', () => importPass(this.db, projectName, indexedFiles, { allFiles: structureFiles, chunkSize: CHUNK }), report, errorCounter), timings);
        await this.withTiming('calls', () => this.runChunkedPass('calls', () => callResolutionPass(this.db, projectName, indexedFiles, { chunkSize: CHUNK }), report, errorCounter), timings);
        // Pass 5.5 — typeof resolution: emit TYPEOF_REFERENCES edges for
        // `typeof X`, `ReturnType<typeof X>`, and the other 4 ADR D3 patterns.
        // Runs AFTER call resolution so the symbol index is populated.
        await this.withTiming('typeof_resolution', () => this.runChunkedPass('typeof_resolution', () => typeofResolutionPass(this.db, projectName, projectRoot, indexedFiles), report, errorCounter), timings);
        // Pass 6 — ts-morph type-aware CALLS/ASYNC_CALLS resolution.
        // Supersedes tree-sitter edges with compiler_api edges at 0.98 confidence.
        // No-op when tsMorphProject is null (skipTsEnrichment / no tsconfig / prior failure).
        await this.withTiming('ts_morph_resolution', async () => {
            report('ts_morph_resolution');
            try {
                await typescriptEnrichmentPass(this.db, projectName, projectRoot, indexedFiles, { tsMorphProject });
            }
            catch (err) {
                log.warn('[pipeline] pass=ts_morph_resolution threw, isolating: %s', err instanceof Error ? err.message : String(err));
                errorCounter.count++;
            }
            await new Promise((resolve) => setImmediate(resolve));
        }, timings);
        // Pass 7 — first-class REFERENCES edges for blast-radius completeness.
        // Captures type-only references, decorator uses, and JSX element uses that
        // CALLS and TYPEOF_REFERENCES miss. Runs after Pass 6 on the same Project
        // instance (files already refreshed). No-op when tsMorphProject is null.
        await this.withTiming('references', async () => {
            report('references');
            try {
                await referencesPass(this.db, projectName, projectRoot, indexedFiles, { tsMorphProject });
            }
            catch (err) {
                log.warn('[pipeline] pass=references threw, isolating: %s', err instanceof Error ? err.message : String(err));
                errorCounter.count++;
            }
            await new Promise((resolve) => setImmediate(resolve));
        }, timings);
    }
    async runEnrichmentPasses(ctx, report, timings) {
        const { projectName, indexedFiles, gitCommitFiles, isIncrementalRun } = ctx;
        // undefined on full reindexes forces unconditional cache rebuild in testDetectPass.
        const changedFiles = isIncrementalRun
            ? new Set(indexedFiles.map((f) => f.relativePath))
            : undefined;
        await this.withTiming('http_links', () => this.runPass('http_links', () => httpLinkPass(this.db, projectName, indexedFiles), report), timings);
        await this.withTiming('test_detection', () => this.runPass('test_detection', () => testDetectPass(this.db, projectName, indexedFiles, changedFiles), report), timings);
        await this.withTiming('enrichment', () => this.runPass('enrichment', () => enrichmentPass(this.db, projectName), report), timings);
        await this.withTiming('git_history', () => this.runPass('git_history', () => gitCoChangePass(this.db, projectName, gitCommitFiles), report), timings);
    }
    async runAllPasses(ctx, indexedFiles, structureFiles, report) {
        const { projectName, projectRoot, errCount, isIncrementalRun, tsMorphProject } = ctx;
        const timings = {};
        // Pre-fetch async data before entering synchronous SQLite transactions.
        const gitStart = performance.now();
        report('git_prefetch');
        const gitCommitFiles = await prefetchGitCoChangeData(projectRoot);
        Object.assign(timings, { git_prefetch: performance.now() - gitStart });
        await this.runCorePasses({ projectName, projectRoot, indexedFiles, structureFiles, tsMorphProject }, report, timings, errCount);
        await this.runEnrichmentPasses({ projectName, indexedFiles, gitCommitFiles, isIncrementalRun }, report, timings);
        return timings;
    }
    finalizeIndex(projectName, options, indexedFiles) {
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
    async discoverAndResolve(options, projectName, progress) {
        const allFiles = await discoverFiles(options.projectRoot, options);
        progress.filesTotal = allFiles.length;
        const isIncremental = options.incremental !== false;
        const { filesToProcess, isIncrementalRun } = await this.resolveFilesToProcess(isIncremental, projectName, allFiles, options.changedPaths, options.onFilePruned);
        // Preserve the last-known-good node/edge counts for existing projects.
        // Zeroing them here poisoned the cache on every incremental run — a no-op
        // fast-path that followed would return without calling finalizeIndex, leaving
        // the cache stuck at 0 while the per-label breakdown (computed live) was correct.
        // A brand-new project still starts at 0; a real index pass still overwrites with
        // fresh live counts via finalizeIndex at the end of runIndex.
        const existing = this.db.getProject(projectName);
        this.db.upsertProject({
            name: projectName,
            root_path: options.projectRoot,
            indexed_at: Date.now(),
            node_count: existing?.node_count ?? 0,
            edge_count: existing?.edge_count ?? 0,
        });
        return { allFiles, filesToProcess, isIncrementalRun };
    }
    async runIndex(options, projectName, report, progress) {
        const startTime = progress.startedAt;
        report('discovery');
        const { allFiles, filesToProcess, isIncrementalRun } = await this.discoverAndResolve(options, projectName, progress);
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
        const tsMorphProject = options.tsMorphProject ?? null;
        const phaseTimingsMs = await this.runAllPasses({ projectName, projectRoot: options.projectRoot, errCount, isIncrementalRun, tsMorphProject }, indexedFiles, structureFiles, report);
        report('finalizing');
        const { nodesCreated, edgesCreated } = this.finalizeIndex(projectName, options, indexedFiles);
        return buildIndexResult({
            db: this.db, projectName, allFiles, filesToProcess, indexedFiles,
            nodesCreated, edgesCreated, phaseTimingsMs, passErrors: errCount.count, progress, isIncrementalRun, startTime,
        });
    }
    buildIndexProgress(startTime, errors) {
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
    async index(options) {
        const startTime = Date.now();
        log.info(`[trace:pipeline.index] start incremental=${options.incremental ?? false} root=${options.projectRoot}`);
        const errors = [];
        const projectName = options.projectName ??
            path
                .basename(options.projectRoot)
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-');
        const progress = this.buildIndexProgress(startTime, errors);
        const report = (phase) => {
            progress.phase = phase;
            progress.elapsedMs = Date.now() - startTime;
            progress.errors = errors;
            options.onProgress?.(progress);
        };
        try {
            const result = await this.runIndex(options, projectName, report, progress);
            log.info(`[trace:pipeline.index] done in ${Date.now() - startTime}ms incremental=${result.incremental} files=${result.filesIndexed}`);
            return result;
        }
        catch (err) {
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
    pruneDeletedFiles(projectName, allFiles, onFilePruned) {
        const diskPaths = new Set(allFiles.map((f) => f.relativePath));
        // Build a rel→absolute map from the current allFiles snapshot so we can
        // fire onFilePruned with the absolute path (needed for ts-morph forget()).
        const relToAbs = new Map(allFiles.map((f) => [f.relativePath, f.absolutePath]));
        for (const hash of this.db.getAllFileHashes(projectName)) {
            if (!diskPaths.has(hash.rel_path)) {
                // Wrap each file's two writes in one transaction so a mid-loop crash
                // cannot leave nodes deleted but the hash record surviving (which would
                // make the file appear "unchanged" forever on the next incremental run).
                this.db.transaction(() => {
                    this.db.deleteNodesByFile(projectName, hash.rel_path);
                    this.db.deleteFileHash(projectName, hash.rel_path);
                });
                // Notify the caller (e.g. worker) that this file was pruned. (D7)
                // Absolute path: prefer the allFiles map (file may already be gone from
                // disk, so we reconstruct from the root). Falls back to rel_path if the
                // file was somehow absent from the discovered list.
                const absolutePath = relToAbs.get(hash.rel_path);
                if (absolutePath)
                    onFilePruned?.(absolutePath);
            }
        }
    }
    async resolveFilesToProcess(isIncremental, projectName, allFiles, changedPaths, onFilePruned) {
        if (isIncremental && this.db.getProject(projectName)) {
            return resolveIncrementalFiles({
                db: this.db,
                projectName,
                allFiles,
                changedPaths,
                pruneDeleted: (files) => this.pruneDeletedFiles(projectName, files, onFilePruned),
                deleteNodes: (rel) => this.db.deleteNodesByFile(projectName, rel),
                onFilePruned,
            });
        }
        this.db.deleteProject(projectName);
        return { filesToProcess: allFiles, isIncrementalRun: false };
    }
}
//# sourceMappingURL=indexingPipeline.js.map
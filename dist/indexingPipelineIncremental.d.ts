/**
 * indexingPipelineIncremental.ts — File discovery and incremental reindex helpers.
 *
 * Extracted from indexingPipeline.ts to satisfy the 300-line file limit.
 * These are module-level helpers used by IndexingPipeline; they have no
 * dependency on the class itself and can be tested in isolation.
 */
import { GraphDatabase } from './graphDatabase';
import type { DiscoveredFile, IndexingOptions } from './indexingPipelineTypes';
export declare function discoverFiles(projectRoot: string, options: IndexingOptions): Promise<DiscoveredFile[]>;
export declare function filterChangedFiles(db: GraphDatabase, projectName: string, files: DiscoveredFile[]): Promise<{
    changed: DiscoveredFile[];
    unchanged: string[];
}>;
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
export declare function filterChangedFilesSubset(db: GraphDatabase, projectName: string, allFiles: DiscoveredFile[], candidatePaths: string[]): Promise<{
    changed: DiscoveredFile[];
    unchanged: string[];
}>;
/** Options for resolveIncrementalFiles. */
export interface ResolveIncrementalOpts {
    db: GraphDatabase;
    projectName: string;
    allFiles: DiscoveredFile[];
    changedPaths?: string[];
    pruneDeleted: (allFiles: DiscoveredFile[]) => void;
    deleteNodes: (relativePath: string) => void;
    /**
     * Called for each file whose nodes are pruned from the graph (file deleted
     * from disk). Receives the absolute path of the pruned file.
     * Mirrors the deleteNodes callback. (D7)
     *
     * Used by the worker to call `tsMorphProject?.getSourceFile(path)?.forget()`
     * so the ts-morph language service releases memory for deleted files.
     * This phase establishes the seam; the pass that populates it lands in Phase 3.
     */
    onFilePruned?: (absolutePath: string) => void;
}
/**
 * Core incremental-reindex resolution: selects which files to process,
 * classifying only the watcher-hinted subset when available (O(K))
 * or the full catalog otherwise (O(N)).
 *
 * Returns the files to process and whether this is a true incremental run.
 * Returns empty filesToProcess when changed=0, signalling a no-op fast-path.
 */
export declare function resolveIncrementalFiles(opts: ResolveIncrementalOpts): Promise<{
    filesToProcess: DiscoveredFile[];
    isIncrementalRun: boolean;
}>;
//# sourceMappingURL=indexingPipelineIncremental.d.ts.map
/**
 * indexingPipelineTypes.ts — Type definitions for the multi-pass indexing pipeline.
 *
 * Defines the options, progress reporting, result, and per-file tracking types
 * used by IndexingPipeline to orchestrate project indexing.
 */
import type { ParseAnomalyResult } from './parseAnomalyDetection';
import type { ParsedFileResult } from './treeSitterTypes';
export interface IndexingOptions {
    projectRoot: string;
    projectName?: string;
    incremental?: boolean;
    maxFileSize?: number;
    maxFiles?: number;
    ignorePaths?: string[];
    onProgress?: (progress: IndexingProgress) => void;
    /**
     * Optional hint from the watcher: the absolute paths that triggered this
     * reindex. When provided, the incremental scan skips the O(N_all_files)
     * filterChangedFiles walk and classifies only these specific paths.
     * The hash check is still applied (watcher events can be spurious).
     */
    changedPaths?: string[];
}
export interface IndexingProgress {
    phase: string;
    filesTotal: number;
    filesProcessed: number;
    nodesCreated: number;
    edgesCreated: number;
    errors: string[];
    startedAt: number;
    elapsedMs: number;
}
export interface IndexingResult {
    projectName: string;
    success: boolean;
    filesIndexed: number;
    filesSkipped: number;
    nodesCreated: number;
    edgesCreated: number;
    errors: string[];
    durationMs: number;
    incremental: boolean;
    phaseTimingsMs?: Record<string, number>;
    parseAnomalies?: ParseAnomalyResult;
    passErrors?: number;
}
export interface DiscoveredFile {
    absolutePath: string;
    relativePath: string;
    extension: string;
    sizeBytes: number;
    mtimeMs: number;
}
export interface IndexedFile extends DiscoveredFile {
    contentHash: string;
    parsed: ParsedFileResult | null;
}
//# sourceMappingURL=indexingPipelineTypes.d.ts.map
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
    /**
     * CPU escape-valve: skip the ts-morph type-aware enrichment pass entirely.
     * When true, `getOrInitTsMorphProject` returns null and the enrichment pass
     * is a no-op. Set by the operator when the dev box cannot afford the
     * ts-morph language-service heap overhead. (D3)
     */
    skipTsEnrichment?: boolean;
    /**
     * Called for each file whose nodes are pruned from the graph during an
     * incremental run (file deleted from disk). Receives the absolute path.
     * Mirrors the internal deleteNodes callback. (D7)
     *
     * NOTE: Not serialisable across the worker IPC boundary (function). The
     * worker supplies this locally — it is NOT part of IndexRequestOptions.
     * Omitted from IndexRequestOptions automatically because it is not in
     * the set of JSON-serialisable fields (workers reconstruct it locally).
     */
    onFilePruned?: (absolutePath: string) => void;
    /**
     * The worker-local ts-morph Project singleton for Pass 6 (D2).
     * Null when skipTsEnrichment is set, no tsconfig.json exists, or a
     * prior init attempt threw. Not serialisable across the IPC boundary —
     * the worker supplies this locally, not via IndexRequestOptions.
     */
    tsMorphProject?: import('ts-morph').Project | null;
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
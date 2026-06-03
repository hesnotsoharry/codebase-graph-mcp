/**
 * indexingWorkerTypes.ts — Discriminated-union message types for
 * main-process ↔ indexing-worker communication.
 *
 * All values must be plain JSON-serialisable — no class instances,
 * no WASM objects, no Buffer/ArrayBuffer.
 */
import type { IndexingOptions, IndexingProgress, IndexingResult } from './indexingPipelineTypes';
/**
 * Stripped options sent across the thread boundary.
 * Non-serialisable fields are omitted — they cannot survive worker posts:
 *   - `onProgress` → progress comes back via WorkerProgress messages.
 *   - `onFilePruned` → worker supplies this locally (D7).
 *   - `tsMorphProject` → worker-local singleton, reconstructed by
 *     getOrInitTsMorphProject inside handleIndexRepository (D2/D3).
 */
export type IndexRequestOptions = Omit<IndexingOptions, 'onProgress' | 'onFilePruned' | 'tsMorphProject'>;
export interface IndexRepositoryRequest {
    type: 'indexRepository';
    requestId: string;
    options: IndexRequestOptions;
}
export interface DisposeRequest {
    type: 'dispose';
    requestId: string;
}
/**
 * Request worker to run a launch-time catalog diff: stat all stored file
 * hashes, detect stale/deleted files, and conditionally trigger an
 * incremental reindex — all off the main thread.
 */
export interface LaunchDiffRequest {
    type: 'launchDiff';
    requestId: string;
    projectRoot: string;
    projectName: string;
    /** When true, skip the ts-morph enrichment passes (Pass 6/7) for this diff index. Wired in Wave 4 Phase 3. */
    skipTsEnrichment?: boolean;
}
export type IndexingWorkerRequest = IndexRepositoryRequest | DisposeRequest | LaunchDiffRequest;
export interface WorkerProgressMessage {
    type: 'progress';
    requestId: string;
    progress: IndexingProgress;
}
export interface WorkerResultMessage {
    type: 'result';
    requestId: string;
    result: IndexingResult;
}
export interface WorkerErrorMessage {
    type: 'error';
    requestId: string;
    message: string;
    stack?: string;
}
export interface WorkerDisposedMessage {
    type: 'disposed';
    requestId: string;
}
/** Payload returned from a launchDiff worker job. */
export interface LaunchDiffResult {
    staleCount: number;
    deletedCount: number;
    reindexed: boolean;
    durationMs: number;
}
/** Message posted by the worker after completing a launchDiff request. */
export interface LaunchDiffResultMessage {
    type: 'launchDiffResult';
    requestId: string;
    result: LaunchDiffResult;
}
export type IndexingWorkerResponse = WorkerProgressMessage | WorkerResultMessage | WorkerErrorMessage | WorkerDisposedMessage | LaunchDiffResultMessage;
//# sourceMappingURL=indexingWorkerTypes.d.ts.map
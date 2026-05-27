/**
 * indexingWorkerTypes.ts — Discriminated-union message types for
 * main-process ↔ indexing-worker communication.
 *
 * All values must be plain JSON-serialisable — no class instances,
 * no WASM objects, no Buffer/ArrayBuffer.
 */

import type { IndexingOptions, IndexingProgress, IndexingResult } from './indexingPipelineTypes';

// ── Main → Worker ────────────────────────────────────────────────────────────

/** Stripped options sent across the thread boundary (onProgress omitted — it is
 *  a function and cannot be serialised; progress comes back via WorkerProgress). */
export type IndexRequestOptions = Omit<IndexingOptions, 'onProgress'>;

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
}

export type IndexingWorkerRequest = IndexRepositoryRequest | DisposeRequest | LaunchDiffRequest;

// ── Worker → Main ────────────────────────────────────────────────────────────

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

export type IndexingWorkerResponse =
  | WorkerProgressMessage
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerDisposedMessage
  | LaunchDiffResultMessage;

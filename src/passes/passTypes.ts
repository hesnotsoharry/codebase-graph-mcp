/**
 * passTypes.ts — Shared types for advanced indexing passes.
 *
 * Each pass receives an IndexingPassContext with the graph database,
 * project metadata, and the list of indexed files from the core pipeline.
 */

import type { GraphDatabase } from '../graphDatabase';
import type { ParsedFileResult } from '../treeSitterTypes';

// ─── Indexed file shape ──────────────────────────────────────────────────────
// Mirrors the pipeline's per-file record. Defined here so passes can import
// it without depending on an indexingPipelineTypes module (which may not exist
// yet).

export interface IndexedFile {
  relativePath: string;
  parsed: ParsedFileResult | null;
}

// ─── Pass context ────────────────────────────────────────────────────────────

export interface IndexingPassContext {
  db: GraphDatabase;
  projectName: string;
  projectRoot: string;
  indexedFiles: IndexedFile[];
}

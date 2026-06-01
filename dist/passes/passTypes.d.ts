/**
 * passTypes.ts — Shared types for advanced indexing passes.
 *
 * Each pass receives an IndexingPassContext with the graph database,
 * project metadata, and the list of indexed files from the core pipeline.
 */
import type { GraphDatabase } from '../graphDatabase';
import type { ParsedFileResult } from '../treeSitterTypes';
export interface IndexedFile {
    relativePath: string;
    parsed: ParsedFileResult | null;
}
export interface IndexingPassContext {
    db: GraphDatabase;
    projectName: string;
    projectRoot: string;
    indexedFiles: IndexedFile[];
}
//# sourceMappingURL=passTypes.d.ts.map
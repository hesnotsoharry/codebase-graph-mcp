/**
 * indexingPipelineCallResolution.ts — Call resolution pass helpers extracted
 * from indexingPipeline.ts to stay under the 300-line limit.
 *
 * Resolves function call sites to their definitions by cross-referencing
 * the file's import map and the global symbols-by-name index.
 */
import type { GraphDatabase } from './graphDatabase';
import type { IndexedFile } from './indexingPipelineTypes';
export declare function callResolutionPass(db: GraphDatabase, projectName: string, indexedFiles: IndexedFile[], options?: {
    chunkSize?: number;
}): void;
//# sourceMappingURL=indexingPipelineCallResolution.d.ts.map
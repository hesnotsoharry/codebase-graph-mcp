/**
 * indexingPipelinePasses.ts — Pass functions extracted from indexingPipeline.ts
 * to keep the main orchestrator under the 300-line limit.
 *
 * Contains: Structure Pass (1), Parse Pass (2), Definition Pass (3), Import Pass (4).
 */
import type { GraphDatabase } from './graphDatabase';
import type { DiscoveredFile, IndexedFile } from './indexingPipelineTypes';
import type { TreeSitterParser } from './treeSitterParser';
export declare function structurePass(db: GraphDatabase, projectName: string, projectRoot: string, files: DiscoveredFile[]): void;
export declare function parsePass(parser: TreeSitterParser, files: DiscoveredFile[], onProgress?: (processed: number, total: number) => void): Promise<IndexedFile[]>;
export declare function definitionPass(db: GraphDatabase, projectName: string, indexedFiles: IndexedFile[], options?: {
    chunkSize?: number;
}): void;
type ImportPassOptions = {
    allFiles?: DiscoveredFile[];
    chunkSize?: number;
};
export declare function importPass(db: GraphDatabase, projectName: string, indexedFiles: IndexedFile[], options?: ImportPassOptions): void;
export {};
//# sourceMappingURL=indexingPipelinePasses.d.ts.map
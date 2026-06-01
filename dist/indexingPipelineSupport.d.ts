/**
 * indexingPipelineSupport.ts — Helper types and functions extracted from
 * indexingPipeline.ts to keep the main file under the 300-line limit.
 */
import ignore from 'ignore';
import type { DiscoveredFile, IndexedFile } from './indexingPipelineTypes';
import type { ExtractedDefinition } from './treeSitterTypes';
export { buildFileEdges, buildFileNodes, buildFileQnMap, buildFolderEdges, buildFolderNodes, getOrCreatePackageNode, resolveRelativeImport, } from './indexingPipelineStructure';
export declare const ALWAYS_IGNORE_DIRS: Set<string>;
export declare const ALWAYS_IGNORE_FILES: Set<string>;
export declare const ALWAYS_IGNORE_EXTENSIONS: Set<string>;
/**
 * Returns true when an absolute or relative file path should never be indexed.
 * Combines ALWAYS_IGNORE_DIRS segment membership with the worktree path regex.
 */
export declare function isPathSkipped(filePath: string): boolean;
export declare function loadIgnoreRules(projectRoot: string, extraIgnores: string[]): Promise<ReturnType<typeof ignore>>;
export interface WalkContext {
    projectRoot: string;
    ig: ReturnType<typeof ignore>;
    maxSize: number;
    maxFiles: number;
    files: DiscoveredFile[];
}
export declare function walkDirectory(dir: string, ctx: WalkContext): Promise<void>;
export declare function hashFileContent(filePath: string): Promise<string>;
export declare function isEntryPoint(def: ExtractedDefinition, file: IndexedFile): boolean;
export declare function buildDefProps(def: ExtractedDefinition, file: IndexedFile): Record<string, unknown>;
export interface FileQnMap {
    map: Map<string, string>;
}
//# sourceMappingURL=indexingPipelineSupport.d.ts.map
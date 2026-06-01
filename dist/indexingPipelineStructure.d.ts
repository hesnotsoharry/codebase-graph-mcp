/**
 * indexingPipelineStructure.ts — Structure and import pass helpers extracted from
 * indexingPipelineSupport.ts to keep it under the 300-line limit.
 */
import type { GraphDatabase } from './graphDatabase';
import type { GraphEdge, GraphNode } from './graphDatabaseTypes';
import type { DiscoveredFile, IndexedFile } from './indexingPipelineTypes';
export declare function buildFolderNodes(projectName: string, files: DiscoveredFile[]): GraphNode[];
export declare function buildFolderEdges(projectName: string, files: DiscoveredFile[]): Omit<GraphEdge, 'id'>[];
export declare function buildFileNodes(projectName: string, files: DiscoveredFile[]): GraphNode[];
export declare function buildFileEdges(projectName: string, files: DiscoveredFile[]): Omit<GraphEdge, 'id'>[];
export declare function buildFileQnMap(projectName: string, files: (DiscoveredFile | IndexedFile)[]): Map<string, string>;
export declare function resolveRelativeImport(importSource: string, fileDir: string, fileQnMap: Map<string, string>): string | null;
export declare function getOrCreatePackageNode(db: GraphDatabase, projectName: string, importSource: string): string;
//# sourceMappingURL=indexingPipelineStructure.d.ts.map
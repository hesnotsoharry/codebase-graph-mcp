/**
 * graphDatabaseSession.ts — Session-scoped change detection and catalog-hash helpers.
 *
 * Extracted from graphDatabase.ts to keep it under the 300-line ESLint limit.
 * Contains: per-session blast-radius analysis, catalog hash computation, and
 * project prune helpers.
 */
import type Database from 'better-sqlite3';
import type { ChangedSymbol, ChangedSymbolsForSession } from './detectChangesForSessionTypes';
import type { FileHashRecord, GraphEdge, GraphNode } from './graphDatabaseTypes';
export interface SessionDbAccessor {
    getFileHash(project: string, relPath: string): FileHashRecord | null;
    getNodesByFile(project: string, filePath: string): GraphNode[];
    getNode(id: string): GraphNode | null;
    getInboundEdges(nodeId: string): GraphEdge[];
}
/** Check whether a file's mtime has advanced past the stored hash record. */
export declare function isFileChanged(db: SessionDbAccessor, project: string, relPath: string): boolean;
/** Collect all immediate inbound neighbour IDs for a given node. */
export declare function collectInboundNeighbours(db: SessionDbAccessor, id: string, next: Set<string>): void;
/** BFS caller expansion up to maxHops levels. */
export declare function expandCallers(db: SessionDbAccessor, seedIds: Set<string>, maxHops: number): Map<string, ChangedSymbol>;
/** Full session change detection: returns changed files + affected symbol blast radius. */
export declare function detectChangesForSession(db: SessionDbAccessor, projectName: string, sessionFiles: string[]): ChangedSymbolsForSession;
/** Write a catalog hash for the given project to graph_metadata. */
export declare function writeCatalogHash(db: Database.Database, projectName: string): void;
/**
 * Invalidate the stored catalog hash for the given project by writing an empty string.
 * `verifyCatalogHash` will return false on next call, triggering a clean rebuild.
 * Use when a pass threw during indexing so a partial index is not accepted as complete.
 */
export declare function invalidateCatalogHash(db: Database.Database, projectName: string): void;
/** Verify the stored catalog hash matches the current file-hash state. Returns true if valid. */
export declare function verifyCatalogHash(db: Database.Database, projectName: string): boolean;
/** Delete file_hashes and project rows; return counts of orphaned nodes and edges. */
export declare function pruneProject(db: Database.Database, projectName: string): {
    nodes: number;
    edges: number;
};
//# sourceMappingURL=graphDatabaseSession.d.ts.map
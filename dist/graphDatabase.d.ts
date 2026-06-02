/**
 * graphDatabase.ts — SQLite property graph store backed by better-sqlite3.
 *
 * Manages the lifecycle of the database, schema creation, and CRUD operations
 * for nodes and edges. All operations are synchronous (better-sqlite3's design).
 */
import type { ChangedSymbolsForSession } from './detectChangesForSessionTypes';
import { type BfsOptions, type NodesByDegreeOptions } from './graphDatabaseHelpers';
import type { ADRRecord, EdgeType, FileHashRecord, GraphEdge, GraphNode, NodeFilter, NodeLabel, NodeSearchResult, ProjectRecord } from './graphDatabaseTypes';
export declare class GraphDatabase {
    private db;
    private stmts;
    constructor(dbPath?: string, opts?: {
        readonly?: boolean;
    });
    private applyPragmas;
    private createSchema;
    private runMigrations;
    private prepareStatements;
    upsertProject(project: ProjectRecord): void;
    getProject(name: string): ProjectRecord | null;
    listProjects(): ProjectRecord[];
    deleteProject(name: string): void;
    touchProjectOpened(name: string): void;
    getProjectLastOpened(name: string): number | null;
    listAllProjects(): {
        name: string;
        last_opened_at: number;
    }[];
    insertNode(node: GraphNode): void;
    insertNodes(nodes: GraphNode[]): void;
    getNode(id: string): GraphNode | null;
    getNodesByLabel(project: string, label: NodeLabel): GraphNode[];
    getNodesByFile(project: string, filePath: string): GraphNode[];
    deleteNodesByProject(project: string): void;
    deleteNodesByFile(project: string, filePath: string): void;
    /** Delete nodes whose file_path contains substring (GC skip rules). Returns deleted count. */
    deleteNodesByFilePathSubstring(project: string, substring: string): number;
    updateNodeProps(id: string, props: Record<string, unknown>): void;
    insertEdge(edge: Omit<GraphEdge, 'id'>): void;
    insertEdges(edges: Omit<GraphEdge, 'id'>[]): void;
    getOutboundEdges(nodeId: string, type?: EdgeType): GraphEdge[];
    getInboundEdges(nodeId: string, type?: EdgeType): GraphEdge[];
    deleteEdgesByProject(project: string): void;
    /**
     * Delete all outbound edges of a given type from a source node, project-scoped. (D5)
     *
     * Used by the ts-morph enrichment pass to supersede a wrong-target edge:
     * when compiler resolution resolves a call to a *different* target than
     * tree-sitter did, the (source, target, type) triplet differs so
     * INSERT OR REPLACE won't remove the old edge. This method removes the
     * stale outbound edges before the correct-target edge is inserted.
     *
     * Scoped to `project` so external-package edges on other projects that
     * happen to share source_id and type are never touched.
     */
    deleteOutboundEdgesOfType(project: string, sourceId: string, type: EdgeType): void;
    searchNodes(filter: NodeFilter): NodeSearchResult;
    searchNodesFts(query: string, limit?: number): GraphNode[];
    searchNodesRanked(project: string, query: string, limit?: number): Array<GraphNode & {
        rank: number;
    }>;
    upsertFileHash(record: FileHashRecord): void;
    getFileHash(project: string, relPath: string): FileHashRecord | null;
    getAllFileHashes(project: string): FileHashRecord[];
    deleteFileHashes(project: string): void;
    deleteFileHash(project: string, relPath: string): void;
    upsertAdr(record: ADRRecord): void;
    getAdr(project: string): ADRRecord | null;
    deleteAdr(project: string): void;
    listAdrs(): ADRRecord[];
    getNodeCount(project: string): number;
    getEdgeCount(project: string): number;
    getNodeLabelCounts(project: string): Record<NodeLabel, number>;
    getEdgeTypeCounts(project: string): Record<EdgeType, number>;
    getRelationshipPatterns(project: string): string[];
    getNodeDegree(nodeId: string, type?: EdgeType, direction?: 'in' | 'out' | 'both'): number;
    getNodesByDegree(project: string, options: NodesByDegreeOptions): NodeSearchResult;
    bfsTraversal(options: BfsOptions & {
        maxNodes?: number;
    }): Array<{
        id: string;
        depth: number;
        path: string[];
    }>;
    rawQuery(sql: string, params?: unknown[]): unknown[];
    transaction<T>(fn: () => T): T;
    setGraphMetadata(key: string, value: string): void;
    getGraphMetadata(key: string): string | null;
    pruneProject(projectName: string): {
        nodes: number;
        edges: number;
    };
    writeCatalogHash(projectName: string): void;
    invalidateCatalogHash(projectName: string): void;
    verifyCatalogHash(projectName: string): boolean;
    detectChangesForSession(projectName: string, sessionFiles: string[]): ChangedSymbolsForSession;
    close(): void;
}
//# sourceMappingURL=graphDatabase.d.ts.map
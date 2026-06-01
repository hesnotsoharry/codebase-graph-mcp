/**
 * graphStore.ts — SQLite-backed graph store using better-sqlite3.
 *
 * Replaces the previous in-memory Map + JSON persistence. All operations
 * are synchronous (better-sqlite3's design). The async save()/load()
 * methods are preserved for API compat but are effectively no-ops — data
 * is persisted on every write via WAL.
 */
import type { IGraphStore } from './graphStoreTypes';
import type { GraphEdge, GraphNode } from './graphTypes';
export type { IGraphStore } from './graphStoreTypes';
export declare class GraphStore implements IGraphStore {
    private db;
    private stmts;
    private txAddBulk;
    private txClearFile;
    private txReplaceEdges;
    private txRemoveNode;
    constructor(projectRoot: string);
    private ensureSchema;
    private insertNode;
    private insertEdge;
    addNode(node: GraphNode): void;
    removeNode(id: string): void;
    getNode(id: string): GraphNode | undefined;
    getAllNodes(): GraphNode[];
    getNodesByType(type: GraphNode['type']): GraphNode[];
    getNodesByFile(filePath: string): GraphNode[];
    addEdge(edge: GraphEdge): void;
    removeEdgesForNode(nodeId: string): void;
    removeEdgesForFile(filePath: string): void;
    getEdgesFrom(nodeId: string): GraphEdge[];
    getEdgesTo(nodeId: string): GraphEdge[];
    getAllEdges(): GraphEdge[];
    replaceAllEdges(edges: GraphEdge[]): void;
    addBulk(nodes: GraphNode[], edges: GraphEdge[]): void;
    clearFile(filePath: string): void;
    clear(): void;
    save(): Promise<void>;
    load(): Promise<boolean>;
    nodeCount(): number;
    edgeCount(): number;
    fileCount(): number;
    close(): void;
    /** Wrap `fn` in a SQLite transaction. */
    transaction<T>(fn: () => T): T;
}
//# sourceMappingURL=graphStore.d.ts.map
/**
 * graphStoreTypes.ts — Interface contract for graph store implementations.
 *
 * Both GraphStoreMemory (worker thread) and GraphStoreSqlite (main thread)
 * implement this interface.
 */
import type { GraphEdge, GraphNode } from './graphTypes';
export interface IGraphStore {
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
    transaction<T>(fn: () => T): T;
}
//# sourceMappingURL=graphStoreTypes.d.ts.map
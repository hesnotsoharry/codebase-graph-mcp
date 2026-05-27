/**
 * graphStoreTypes.ts — Interface contract for graph store implementations.
 *
 * Both GraphStoreMemory (worker thread) and GraphStoreSqlite (main thread)
 * implement this interface.
 */

import type { GraphEdge, GraphNode } from './graphTypes';

export interface IGraphStore {
  // Node CRUD
  addNode(node: GraphNode): void;
  removeNode(id: string): void;
  getNode(id: string): GraphNode | undefined;
  getAllNodes(): GraphNode[];
  getNodesByType(type: GraphNode['type']): GraphNode[];
  getNodesByFile(filePath: string): GraphNode[];

  // Edge CRUD
  addEdge(edge: GraphEdge): void;
  removeEdgesForNode(nodeId: string): void;
  removeEdgesForFile(filePath: string): void;
  getEdgesFrom(nodeId: string): GraphEdge[];
  getEdgesTo(nodeId: string): GraphEdge[];
  getAllEdges(): GraphEdge[];
  replaceAllEdges(edges: GraphEdge[]): void;

  // Bulk operations
  addBulk(nodes: GraphNode[], edges: GraphEdge[]): void;
  clearFile(filePath: string): void;
  clear(): void;

  // Persistence (no-op in memory, no-op in SQLite/WAL)
  save(): Promise<void>;
  load(): Promise<boolean>;

  // Stats
  nodeCount(): number;
  edgeCount(): number;
  fileCount(): number;

  // Lifecycle
  close(): void;

  // Transaction support (no-op in memory, wraps db.transaction in SQLite)
  transaction<T>(fn: () => T): T;
}

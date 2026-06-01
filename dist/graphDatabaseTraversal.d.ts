/**
 * graphDatabaseTraversal.ts — BFS traversal, degree queries, and degree-filtered
 * node lookup helpers extracted from graphDatabaseHelpers.ts.
 *
 * All functions accept a `db` parameter (better-sqlite3 Database instance) so
 * they can be used as stateless helpers outside the GraphDatabase class.
 */
import type Database from 'better-sqlite3';
import type { GraphNode, NodeSearchResult } from './graphDatabaseTypes';
export interface BfsOptions {
    startNodeId: string;
    edgeTypes: string[];
    direction: 'outbound' | 'inbound';
    maxDepth: number;
    maxNodes?: number;
    minConfidence?: number;
}
/** Build the BFS SQL and run it. Returns rows with id/depth/path. */
export declare function runBfsTraversal(db: Database.Database, opts: BfsOptions): Array<{
    id: string;
    depth: number;
    path: string[];
}>;
/** Build degree count SQL and run it for a single node. */
export declare function runNodeDegreeQuery(db: Database.Database, nodeId: string, type: string | undefined, direction: 'in' | 'out' | 'both'): number;
/** Options for the getNodesByDegree query. */
export interface NodesByDegreeOptions {
    label?: string;
    type?: string;
    direction: 'in' | 'out' | 'both';
    minDegree?: number;
    maxDegree?: number;
    excludeEntryPoints?: boolean;
    limit?: number;
    offset?: number;
}
/** Build the degree sub-expression for a node-scoped query. */
export declare function buildNodeDegreeExpr(direction: 'in' | 'out' | 'both', type?: string): string;
/** Add min/max degree conditions with per-use type param bindings. */
export declare function addNodeDegreeConditions(options: NodesByDegreeOptions, conditions: string[], params: unknown[]): void;
/** Execute getNodesByDegree query with degree filtering. */
export declare function runGetNodesByDegree(db: Database.Database, project: string, options: NodesByDegreeOptions, rowToNode: (row: unknown) => GraphNode): NodeSearchResult;
//# sourceMappingURL=graphDatabaseTraversal.d.ts.map
/**
 * graphDatabaseHelpers.ts — Helper functions extracted from graphDatabase.ts
 * to keep the main file under the 300-line limit.
 *
 * Contains: database path resolution, prepared statement builders,
 * row mappers, search/traversal query runners, and query condition helpers.
 * SQL DDL lives in graphDatabaseSchema.ts.
 */
import type Database from 'better-sqlite3';
import type { ADRRecord, EdgeType, FileHashRecord, GraphEdge, GraphNode, NodeFilter, NodeLabel, NodeSearchResult, ProjectRecord } from './graphDatabaseTypes';
export { SCHEMA_SQL } from './graphDatabaseSchema';
/** Build the core node/edge CRUD statements. */
export declare function buildCoreStatements(db: Database.Database): Record<string, Database.Statement>;
/** Build file-hash and project statements. */
export declare function buildHashAndProjectStatements(db: Database.Database): Record<string, Database.Statement>;
/** Build search, label, stats, and ADR statements. */
export declare function buildSearchAndStatsStatements(db: Database.Database): Record<string, Database.Statement>;
/**
 * Delete all outbound edges of a given type from a specific source node,
 * scoped to a project. Project-scoping is mandatory (D5): without it, a
 * supersession delete on an intra-project edge could accidentally remove
 * correct external-package edges that happen to share the same source_id
 * and type across project boundaries.
 *
 * Used by the ts-morph enrichment pass (Phase 2) to remove the wrong-target
 * edge before inserting the compiler-resolved correct-target edge, when
 * ts-morph resolves a call to a *different* target than tree-sitter did
 * (INSERT OR REPLACE handles same-triplet supersession automatically, but
 * cannot remove a differing-target edge).
 */
export declare function deleteOutboundEdgesOfType(db: Database.Database, project: string, sourceId: string, type: string): void;
/** Build base conditions from simple NodeFilter properties. */
export declare function buildBaseConditions(filter: NodeFilter, conditions: string[], params: unknown[]): void;
/** Build a degree sub-expression for the given direction and edge type. */
export declare function buildDegreeExpr(edgeDir: 'inbound' | 'outbound' | 'both', edgeType?: string): string;
/** Add degree conditions to the WHERE clause. */
export declare function addDegreeConditions(filter: NodeFilter, conditions: string[], params: unknown[]): void;
export declare function rowToNode(row: unknown): GraphNode;
export declare function rowToEdge(row: unknown): GraphEdge;
export declare function rowToProject(row: Record<string, unknown>): ProjectRecord;
export declare function rowToFileHash(r: Record<string, unknown>): FileHashRecord;
export declare function rowToAdr(r: Record<string, unknown>): ADRRecord;
/** Map label-count rows to a typed record. */
export declare function aggregateNodeLabelCounts(rows: Array<{
    label: string;
    count: number;
}>): Record<NodeLabel, number>;
/** Map type-count rows to a typed record. */
export declare function aggregateEdgeTypeCounts(rows: Array<{
    type: string;
    count: number;
}>): Record<EdgeType, number>;
/** Execute the searchNodes query against the DB and return results + pagination. */
export declare function runSearchNodes(db: Database.Database, filter: NodeFilter, rowToNode: (row: unknown) => GraphNode): NodeSearchResult;
/**
 * 3-tier ranked symbol search: exact (rank 0) > prefix (rank 1) > substring (rank 2).
 * Tiers are mutually exclusive — no duplicates across tiers.
 */
export declare function runSearchNodesRanked(db: Database.Database, project: string, query: string, limit: number): Array<GraphNode & {
    rank: number;
}>;
export type { BfsOptions, NodesByDegreeOptions } from './graphDatabaseTraversal';
export { addNodeDegreeConditions, buildNodeDegreeExpr, runBfsTraversal, runGetNodesByDegree, runNodeDegreeQuery, } from './graphDatabaseTraversal';
//# sourceMappingURL=graphDatabaseHelpers.d.ts.map
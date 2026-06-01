/**
 * cypherEngine.ts — Minimal Cypher-subset query engine.
 *
 * Translates a limited subset of Cypher queries into SQL against the
 * nodes/edges tables in GraphDatabase. Pattern-based (not a full parser):
 * matches known query shapes and generates corresponding SQL.
 *
 * Supported patterns:
 * - MATCH (n:Label) WHERE ... RETURN ...
 * - MATCH (n:Label)-[:TYPE]->(m:Label) WHERE ... RETURN ...
 * - MATCH (n)-[:TYPE*1..3]->(m) WHERE ... RETURN ...
 * - MATCH (a)-[:X]->(b), (b)-[:Y]->(c) — multi-pattern
 * - OPTIONAL MATCH (a)-[:TYPE]->(b) — LEFT JOIN
 * - UNWIND ['a','b'] AS x — literal list expansion
 * - WHERE: =, <>, CONTAINS, STARTS WITH, ENDS WITH, >, <, >=, <=, AND, OR, IN
 * - RETURN with property access (n.name, n.file_path)
 * - ORDER BY, LIMIT, COUNT, DISTINCT
 *
 * Read-only: rejects anything that isn't a SELECT/WITH statement.
 * Results capped at 200 rows.
 */
import type { HopPattern, MatchPattern, OrderByClause, ParsedQuery, ReturnField, WhereCondition } from './cypherEngineSupport';
import type { GraphDatabase } from './graphDatabase';
export interface CypherQueryResult {
    columns: string[];
    rows: Record<string, unknown>[];
    total: number;
    /**
     * True when more rows exist beyond the returned page. A page limit is always
     * applied — the explicit `limit`, or a 200-row default — so this is true
     * whenever the match set exceeds the page, INCLUDING the default cap with no
     * explicit pagination. It is the signal that an empty/short result is a real
     * answer and not silent truncation; page through the rest with offset/limit.
     */
    truncated: boolean;
}
/** Options for paginated execution of a Cypher query from the MCP tool layer. */
export interface CypherExecuteOptions {
    /** Maximum rows to return (overrides the Cypher LIMIT in the query). */
    limit?: number;
    /** Zero-based row offset (SQL OFFSET). */
    offset?: number;
}
export declare class CypherEngine {
    private db;
    private projectName;
    constructor(db: GraphDatabase, projectName: string);
    execute(query: string, options?: CypherExecuteOptions): CypherQueryResult;
    private parseMatchPattern;
    private parse;
    private parseLimit;
    private toSql;
    private singleNodeSql;
    private singleProjectSql;
    private buildHopConditions;
    private singleHopSql;
    private varpathSql;
    /** Return the right-side node alias(es) from an optional match pattern, for SELECT inclusion. */
    private optionalMatchAliases;
    private buildSelectColumns;
    private buildSelectColumnExpr;
    private addWhereConditions;
}
export type { HopPattern, MatchPattern, OrderByClause, ParsedQuery, ReturnField, WhereCondition };
//# sourceMappingURL=cypherEngine.d.ts.map
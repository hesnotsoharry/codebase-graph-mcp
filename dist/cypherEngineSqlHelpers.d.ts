/**
 * cypherEngineSqlHelpers.ts — SQL building helpers extracted from CypherEngine
 * to keep cypherEngine.ts under the 300-line ESLint limit.
 */
import type { NegatedExistenceCondition, OrderByClause, ScalarWhereCondition } from './cypherEngineSupport';
/**
 * Build the SQL expression for a node property reference.
 * Returns `alias.column` for known SQL columns, or
 * `json_extract(alias.props, '$.key')` for any other key (props fall-through).
 */
export declare function resolveColumnExpression(sqlAlias: string, property: string): string;
/** Convert Cypher comparison operators to SQL operators. */
export declare function cypherOpToSql(op: string): string;
/** Build ORDER BY clause. Uses resolveColumnExpression so props.* keys sort correctly. */
export declare function buildOrderBy(orderBy: OrderByClause[]): string;
/** Build the right-hand side of a WHERE condition: a single placeholder or an IN-list. */
export declare function buildWhereRhs(cond: ScalarWhereCondition): string;
/** Merge a new condition, collapsing OR pairs into a single expression. */
export declare function mergeCondition(conditions: string[], condStr: string, prevConjunction: 'AND' | 'OR' | null): void;
/** Push the parameter value(s) for a WHERE condition (handles LIKE wrapping and IN). */
export declare function pushWhereParam(params: unknown[], cond: ScalarWhereCondition): void;
/**
 * Build the NOT EXISTS subquery fragment for a negated existence condition.
 * Returns a SQL fragment like:
 *   NOT EXISTS (SELECT 1 FROM edges WHERE target_id = n.id AND type = 'CALLS')
 *
 * The fragment contains no bind parameters — the anchor id is referenced by column
 * name (e.g. `n.id`) so it stays correlated with the outer query row.
 */
export declare function buildNotExistsSql(cond: NegatedExistenceCondition): string;
/** Safety: check if a query contains write operations. */
export declare function isWriteQuery(query: string): boolean;
/** Sanitize an identifier to prevent SQL injection in inline values. */
export declare function sanitizeIdentifier(value: string): string;
//# sourceMappingURL=cypherEngineSqlHelpers.d.ts.map
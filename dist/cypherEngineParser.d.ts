/**
 * cypherEngineParser.ts — Clause extraction and WHERE/ORDER BY parsing helpers
 * extracted from CypherEngine class methods.
 *
 * All functions are pure (no class state). They transform query strings into
 * structured types defined in cypherEngineSupport.ts.
 */
import type { OrderByClause, WhereCondition } from './cypherEngineSupport';
/**
 * Throw a clear error if the query contains a top-level clause that the engine
 * does not support. OPTIONAL MATCH and UNWIND are handled by dedicated parse paths.
 * WITH is supported as a single-stage passthrough pipe (Wave 1 Phase 2).
 */
export declare function assertNoUnsupportedClauses(_query: string): void;
/** Extract the content of a named clause from the query string. */
export declare function extractClause(query: string, clause: string): string | null;
/** Extract the OPTIONAL MATCH clause content, or null if absent. */
export declare function extractOptionalMatchClause(query: string): string | null;
/** Extract the UNWIND clause content (list + AS alias), or null if absent. */
export declare function extractUnwindClause(query: string): string | null;
/**
 * Extract the WITH clause content, or null if absent.
 * Strips "STARTS WITH" / "ENDS WITH" occurrences first so they don't trigger.
 * The WITH clause carries variable names to pass through: `a, b` or `a AS x, b`.
 */
export declare function extractWithClause(query: string): string | null;
/**
 * Parse WITH clause content into the list of alias names being passed through.
 * Supports: `a`, `a, b`, `a AS x` (alias renaming is not supported; name-only is returned).
 * Returns the identifiers so the engine can validate they match MATCH-bound aliases.
 */
export declare function parseWithAliases(withStr: string): string[];
/** Parse a single WHERE condition. Recognizes IN-form first, then scalar comparisons, then negated existence. */
export declare function parseSingleCondition(condStr: string): WhereCondition | null;
/** Parse WHERE clause into conditions. Throws on shapes the engine does not understand. */
export declare function parseWhere(whereStr: string): WhereCondition[];
/** Parse ORDER BY clause into a list of sort directives. */
export declare function parseOrderBy(orderByStr: string): OrderByClause[];
/** Parse UNWIND clause content: `['v1','v2'] AS alias` → { values, alias }. */
export declare function parseUnwind(unwindStr: string): import('./cypherEngineSupport').UnwindClause;
//# sourceMappingURL=cypherEngineParser.d.ts.map
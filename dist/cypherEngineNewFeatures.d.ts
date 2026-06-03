/**
 * cypherEngineNewFeatures.ts — SQL builders for Wave-77 features:
 * OPTIONAL MATCH (LEFT JOIN) and UNWIND (VALUES CTE).
 *
 * Extracted from cypherEngine.ts to keep it under the 300-line limit.
 */
import type { HopPattern, MatchPattern, ParsedQuery, UnwindClause } from './cypherEngineSupport';
/**
 * Parse a multi-pattern MATCH clause: `(a)-[:X]->(b), (b)-[:Y]->(c)`.
 * Returns null if only one pattern is present (caller uses parseMatch instead).
 * Throws if any sub-pattern is not a hop.
 */
export declare function parseMultiPattern(matchStr: string): HopPattern[] | null;
/**
 * Build the LEFT JOIN SQL fragment for an OPTIONAL MATCH hop.
 * Returns empty string if om is not a hop pattern.
 * When om.edgeType is set, pushes the type value onto `params` and emits `?`
 * instead of an inline literal — matches the bound-parameter idiom used by
 * buildNotExistsSql and addNodeDegreeConditions.
 */
export declare function buildOptionalHopJoin(om: MatchPattern, leftAlias: string, params: unknown[]): string;
export interface UnwindSqlContext {
    parsed: ParsedQuery;
    unwind: UnwindClause;
    projectName: string;
    buildSelectColumns: (p: ParsedQuery, ...aliases: string[]) => string;
    addWhereConditions: (where: ParsedQuery['where'], conditions: string[], params: unknown[]) => void;
}
export interface MultiPatternSqlContext {
    parsed: ParsedQuery;
    patterns: HopPattern[];
    projectName: string;
    addWhereConditions: (where: ParsedQuery['where'], conditions: string[], params: unknown[]) => void;
}
/** Build SQL for MATCH (a)-[:X]->(b), (b)-[:Y]->(c) ... — chained INNER JOINs. */
export declare function buildMultiPatternSql(ctx: MultiPatternSqlContext): {
    text: string;
    params: unknown[];
};
/**
 * Build SQL for UNWIND ['v1','v2'] AS x ... RETURN ...
 * Uses a VALUES CTE so the statement stays fully read-only.
 */
export declare function buildUnwindSql(ctx: UnwindSqlContext): {
    text: string;
    params: unknown[];
};
//# sourceMappingURL=cypherEngineNewFeatures.d.ts.map
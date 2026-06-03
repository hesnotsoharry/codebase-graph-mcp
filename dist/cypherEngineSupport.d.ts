/**
 * cypherEngineSupport.ts — Helper types and functions extracted from cypherEngine.ts
 * to keep the main file under the max-lines limit.
 */
export type HopPattern = {
    kind: 'hop';
    left: {
        alias: string;
        label: string | null;
    };
    right: {
        alias: string;
        label: string | null;
    };
    edgeAlias: string | null;
    edgeType: string | null;
    direction: 'outbound' | 'inbound';
};
export type MatchPattern = {
    kind: 'single';
    alias: string;
    label: string | null;
} | HopPattern | {
    kind: 'varpath';
    left: {
        alias: string;
        label: string | null;
    };
    right: {
        alias: string;
        label: string | null;
    };
    edgeType: string | null;
    minHops: number;
    maxHops: number;
    direction: 'outbound' | 'inbound';
} | {
    kind: 'multipat';
    patterns: HopPattern[];
};
export type WhereValue = string | number | (string | number)[];
/** Negated existence condition: WHERE NOT (src)-[:TYPE]->(tgt). */
export interface NegatedExistenceCondition {
    kind: 'negated_existence';
    /** Alias of the node already bound in the MATCH clause (the anchor). */
    anchorAlias: string;
    /** Whether the anchor is the source or target of the negated edge. */
    anchorRole: 'source' | 'target';
    /**
     * Edge type filter(s); null means any edge type.
     * A single-element array is semantically identical to the previous `string | null`
     * contract. Multiple elements express alternation: `[:T1|T2|...]`.
     */
    edgeTypes: string[] | null;
    conjunction: 'AND' | 'OR' | null;
}
export interface ScalarWhereCondition {
    kind?: undefined;
    alias: string;
    property: string;
    operator: string;
    /**
     * Value is a scalar for `=`, `<>`, `<`, `>`, `<=`, `>=`, `CONTAINS`,
     * `STARTS WITH`, and `ENDS WITH`. For `IN` it is an array of values.
     */
    value: WhereValue;
    conjunction: 'AND' | 'OR' | null;
}
/** A WHERE condition is either a scalar comparison or a negated existence pattern. */
export type WhereCondition = ScalarWhereCondition | NegatedExistenceCondition;
/** Parsed UNWIND clause: a literal value list and the AS alias. */
export interface UnwindClause {
    values: (string | number)[];
    alias: string;
}
export interface ParsedQuery {
    match: MatchPattern;
    where: WhereCondition[];
    returnFields: ReturnField[];
    orderBy: OrderByClause[];
    limit: number;
    /** SQL OFFSET for pagination; 0 = no offset. */
    offset: number;
    isCount: boolean;
    isDistinct: boolean;
    /** OPTIONAL MATCH pattern — translates to LEFT JOIN. */
    optionalMatch: MatchPattern | null;
    /** UNWIND clause — literal list expansion via VALUES CTE. */
    unwind: UnwindClause | null;
    /** WITH clause alias(es) — currently a passthrough pipe that re-binds aliases. */
    withAliases: string[] | null;
}
export interface ReturnField {
    alias: string;
    property: string;
    outputName: string;
}
export interface OrderByClause {
    alias: string;
    property: string;
    direction: 'ASC' | 'DESC';
}
export declare const MAX_ROWS = 200;
/** Map Cypher node properties to SQL column names */
export declare const PROP_TO_COLUMN: Record<string, string>;
/** Parse MATCH clause into a MatchPattern. */
export declare function parseMatch(matchStr: string): MatchPattern;
/** Parse RETURN clause into fields and detect COUNT/DISTINCT. */
export declare function parseReturn(returnStr: string): {
    fields: ReturnField[];
    isCount: boolean;
    isDistinct: boolean;
};
/** Build the JOIN condition for a single-hop query. */
export declare function buildHopJoinCondition(edgeAlias: string, leftAlias: string, rightAlias: string, direction: 'outbound' | 'inbound'): string;
export type { CypherResolvers, VarpathStartContext, VarpathTemplateOptions, } from './cypherEngineVarpath';
export { buildVarpathEndConditions, buildVarpathSelectParts, buildVarpathSqlTemplate, buildVarpathStartConditions, } from './cypherEngineVarpath';
//# sourceMappingURL=cypherEngineSupport.d.ts.map
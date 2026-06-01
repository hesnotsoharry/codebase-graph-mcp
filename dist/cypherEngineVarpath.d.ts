/**
 * cypherEngineVarpath.ts — Variable-length path (varpath) SQL builder helpers
 * extracted from cypherEngineSupport.ts to keep that file under 300 lines.
 */
import type { ReturnField, WhereCondition } from './cypherEngineSupport';
/** Resolver callbacks used to translate Cypher identifiers and operators to SQL. */
export interface CypherResolvers {
    resolveColumnExpression: (sqlAlias: string, property: string) => string;
    cypherOpToSql: (op: string) => string;
}
/** Context for building varpath start-node conditions. */
export interface VarpathStartContext {
    left: {
        alias: string;
        label: string | null;
    };
    projectName: string;
}
/** Build the start-node WHERE conditions for a varpath query. */
export declare function buildVarpathStartConditions(ctx: VarpathStartContext, where: WhereCondition[], params: unknown[], resolvers: CypherResolvers): string[];
/** Build the end-node WHERE conditions for a varpath query. */
export declare function buildVarpathEndConditions(right: {
    alias: string;
    label: string | null;
}, where: WhereCondition[], params: unknown[], resolvers: CypherResolvers): string[];
/** Options for the WITH RECURSIVE SQL template. */
export interface VarpathTemplateOptions {
    startConditions: string[];
    nextNode: string;
    edgeJoin: string;
    endWhere: string;
    distinct: string;
    selectParts: string[];
    orderBy: string;
}
/** Assemble the WITH RECURSIVE SQL for a variable-length path query. */
export declare function buildVarpathSqlTemplate(opts: VarpathTemplateOptions): string;
/** Build SELECT parts for a varpath query. */
export declare function buildVarpathSelectParts(returnFields: ReturnField[], leftAlias: string, rightAlias: string, resolveColumnExpression: (sqlAlias: string, property: string) => string): string[];
//# sourceMappingURL=cypherEngineVarpath.d.ts.map
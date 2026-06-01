/**
 * cypherEngineNewFeatures.ts — SQL builders for Wave-77 features:
 * OPTIONAL MATCH (LEFT JOIN) and UNWIND (VALUES CTE).
 *
 * Extracted from cypherEngine.ts to keep it under the 300-line limit.
 */
import { buildOrderBy, resolveColumnExpression, sanitizeIdentifier } from './cypherEngineSqlHelpers.js';
import { parseMatch } from './cypherEngineSupport.js';
// ─── Multi-pattern MATCH parsing ─────────────────────────────────────────────
function splitMatchPatterns(matchStr) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of matchStr) {
        if (ch === '(' || ch === '[') {
            depth++;
            current += ch;
        }
        else if (ch === ')' || ch === ']') {
            depth--;
            current += ch;
        }
        else if (ch === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
        }
        else {
            current += ch;
        }
    }
    if (current.trim())
        parts.push(current.trim());
    return parts;
}
/**
 * Parse a multi-pattern MATCH clause: `(a)-[:X]->(b), (b)-[:Y]->(c)`.
 * Returns null if only one pattern is present (caller uses parseMatch instead).
 * Throws if any sub-pattern is not a hop.
 */
export function parseMultiPattern(matchStr) {
    const parts = splitMatchPatterns(matchStr);
    if (parts.length < 2)
        return null;
    return parts.map((part, i) => {
        const p = parseMatch(part);
        if (p.kind !== 'hop') {
            throw new Error(`Multi-pattern MATCH: pattern ${i + 1} must be a hop (got ${p.kind}): "${part}"`);
        }
        return p;
    });
}
// ─── OPTIONAL MATCH ───────────────────────────────────────────────────────────
/**
 * Build the LEFT JOIN SQL fragment for an OPTIONAL MATCH hop.
 * Returns empty string if om is not a hop pattern.
 */
export function buildOptionalHopJoin(om, leftAlias) {
    if (om.kind !== 'hop')
        return '';
    const edgeAlias = 'e_opt';
    const rightAlias = om.right.alias || '_opt_r';
    const srcCol = om.direction === 'outbound' ? 'source_id' : 'target_id';
    const tgtCol = om.direction === 'outbound' ? 'target_id' : 'source_id';
    const edgeTypeCond = om.edgeType
        ? ` AND ${edgeAlias}.type = '${sanitizeIdentifier(om.edgeType)}'`
        : '';
    return (`LEFT JOIN edges ${edgeAlias} ON ${edgeAlias}.${srcCol} = ${leftAlias}.id${edgeTypeCond} ` +
        `LEFT JOIN nodes ${rightAlias} ON ${rightAlias}.id = ${edgeAlias}.${tgtCol}`);
}
function buildUnwindConditions(ctx, nodeAlias, label, params) {
    const conditions = [`${nodeAlias}.project = ?`];
    params.push(ctx.projectName);
    if (label) {
        conditions.push(`${nodeAlias}.label = ?`);
        params.push(label);
    }
    const safeAlias = sanitizeIdentifier(ctx.unwind.alias);
    const safeNodeAlias = sanitizeIdentifier(nodeAlias);
    conditions.push(`${resolveColumnExpression(safeNodeAlias, safeAlias)} = _unwind.val`);
    ctx.addWhereConditions(ctx.parsed.where, conditions, params);
    return conditions;
}
function buildMultiPatternSelect(parsed, nodeAliases) {
    if (parsed.isCount)
        return 'COUNT(*) AS _count';
    const cols = parsed.returnFields
        .filter((f) => nodeAliases.has(f.alias))
        .map((f) => `${resolveColumnExpression(f.alias, f.property)} AS ${f.outputName}`);
    return cols.length > 0 ? cols.join(', ') : `${[...nodeAliases][0]}.*`;
}
/** Build SQL for MATCH (a)-[:X]->(b), (b)-[:Y]->(c) ... — chained INNER JOINs. */
export function buildMultiPatternSql(ctx) {
    const { patterns, parsed } = ctx;
    const first = patterns[0];
    const leftAlias = first.left.alias || '_a';
    const nodeAliases = new Set([leftAlias]);
    // Build JOIN fragments and their params separately so param order matches SQL left-to-right.
    const joinFragments = [];
    const joinParams = [];
    const whereConditions = [`${leftAlias}.project = ?`];
    const whereParams = [ctx.projectName];
    if (first.left.label) {
        whereConditions.push(`${leftAlias}.label = ?`);
        whereParams.push(first.left.label);
    }
    patterns.forEach((pat, idx) => {
        const eAlias = `_e${idx}`;
        const rightAlias = pat.right.alias || `_r${idx}`;
        nodeAliases.add(rightAlias);
        const srcCol = pat.direction === 'outbound' ? 'source_id' : 'target_id';
        const tgtCol = pat.direction === 'outbound' ? 'target_id' : 'source_id';
        const leftA = pat.left.alias || leftAlias;
        const typeCond = pat.edgeType ? ` AND ${eAlias}.type = ?` : '';
        if (pat.edgeType)
            joinParams.push(pat.edgeType);
        joinFragments.push(`JOIN edges ${eAlias} ON ${eAlias}.${srcCol} = ${leftA}.id${typeCond}`);
        joinFragments.push(`JOIN nodes ${rightAlias} ON ${rightAlias}.id = ${eAlias}.${tgtCol}`);
        if (pat.right.label) {
            whereConditions.push(`${rightAlias}.label = ?`);
            whereParams.push(pat.right.label);
        }
    });
    ctx.addWhereConditions(parsed.where, whereConditions, whereParams);
    const selectCols = buildMultiPatternSelect(parsed, nodeAliases);
    const distinct = parsed.isDistinct ? 'DISTINCT ' : '';
    const offsetClause = parsed.offset > 0 ? 'OFFSET ?' : '';
    const sql = [
        `SELECT ${distinct}${selectCols}`,
        `FROM nodes ${leftAlias}`,
        ...joinFragments,
        `WHERE ${whereConditions.join(' AND ')}`,
        `LIMIT ?`,
        offsetClause,
    ].filter(Boolean).join(' ');
    // Join params come before WHERE params in SQL order
    const params = [...joinParams, ...whereParams, parsed.limit + 1];
    if (parsed.offset > 0)
        params.push(parsed.offset);
    return { text: sql, params };
}
/**
 * Build SQL for UNWIND ['v1','v2'] AS x ... RETURN ...
 * Uses a VALUES CTE so the statement stays fully read-only.
 */
export function buildUnwindSql(ctx) {
    const { values, alias } = ctx.unwind;
    if (values.length === 0)
        return { text: 'SELECT NULL WHERE 0', params: [] };
    const params = [];
    const placeholders = values.map(() => '(?)').join(', ');
    for (const v of values)
        params.push(v);
    const nodeAlias = ctx.parsed.match.kind === 'single'
        ? ctx.parsed.match.alias || 'n'
        : 'n';
    const label = ctx.parsed.match.kind === 'single'
        ? ctx.parsed.match.label
        : null;
    const selectCols = ctx.buildSelectColumns(ctx.parsed, nodeAlias);
    const conditions = buildUnwindConditions(ctx, nodeAlias, label, params);
    const safeAlias = sanitizeIdentifier(alias);
    const safeNodeAlias = sanitizeIdentifier(nodeAlias);
    const joinExpr = resolveColumnExpression(safeNodeAlias, safeAlias);
    const orderBy = buildOrderBy(ctx.parsed.orderBy);
    const distinct = ctx.parsed.isDistinct ? 'DISTINCT ' : '';
    const sql = [
        `WITH _unwind(val) AS (VALUES ${placeholders})`,
        `SELECT ${distinct}${selectCols}`,
        `FROM nodes ${nodeAlias}`,
        `JOIN _unwind ON ${joinExpr} = _unwind.val`,
        `WHERE ${conditions.join(' AND ')}`,
        orderBy ? `ORDER BY ${orderBy}` : '',
        `LIMIT ?`,
        ctx.parsed.offset > 0 ? `OFFSET ?` : '',
    ]
        .filter(Boolean)
        .join(' ');
    params.push(ctx.parsed.limit + 1);
    if (ctx.parsed.offset > 0)
        params.push(ctx.parsed.offset);
    return { text: sql, params };
}
//# sourceMappingURL=cypherEngineNewFeatures.js.map
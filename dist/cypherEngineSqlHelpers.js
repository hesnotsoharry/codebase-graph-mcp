/**
 * cypherEngineSqlHelpers.ts — SQL building helpers extracted from CypherEngine
 * to keep cypherEngine.ts under the 300-line ESLint limit.
 */
import { PROP_TO_COLUMN } from './cypherEngineSupport.js';
/**
 * Build the SQL expression for a node property reference.
 * Returns `alias.column` for known SQL columns, or
 * `json_extract(alias.props, '$.key')` for any other key (props fall-through).
 */
export function resolveColumnExpression(sqlAlias, property) {
    // eslint-disable-next-line security/detect-object-injection -- property is a validated identifier from the parsed query
    const sqlCol = PROP_TO_COLUMN[property];
    if (sqlCol)
        return `${sqlAlias}.${sqlCol}`;
    const safeKey = sanitizeIdentifier(property);
    return `json_extract(${sqlAlias}.props, '$.${safeKey}')`;
}
const LIKE_OPS = new Set(['CONTAINS', 'STARTS WITH', 'ENDS WITH']);
const PASSTHROUGH_OPS = new Set(['=', '<>', '>', '<', '>=', '<=', 'IN']);
/** Convert Cypher comparison operators to SQL operators. */
export function cypherOpToSql(op) {
    if (LIKE_OPS.has(op))
        return 'LIKE';
    if (PASSTHROUGH_OPS.has(op))
        return op;
    return '=';
}
/** Build ORDER BY clause. Uses resolveColumnExpression so props.* keys sort correctly. */
export function buildOrderBy(orderBy) {
    if (orderBy.length === 0)
        return '';
    return orderBy
        .map((o) => `${resolveColumnExpression(o.alias, o.property)} ${o.direction}`)
        .join(', ');
}
/** Build the right-hand side of a WHERE condition: a single placeholder or an IN-list. */
export function buildWhereRhs(cond) {
    if (cond.operator === 'IN') {
        const values = Array.isArray(cond.value) ? cond.value : [cond.value];
        if (values.length === 0)
            return '(NULL)'; // empty IN matches nothing
        return `(${values.map(() => '?').join(', ')})`;
    }
    return '?';
}
/** Merge a new condition, collapsing OR pairs into a single expression. */
export function mergeCondition(conditions, condStr, prevConjunction) {
    if (prevConjunction === 'OR') {
        const lastCond = conditions.pop();
        conditions.push(lastCond ? `(${lastCond} OR ${condStr})` : condStr);
    }
    else {
        conditions.push(condStr);
    }
}
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const INDEXED_AT_PROPS = new Set(['indexed_at', 'indexedAt']);
/** Coerce ISO date strings to epoch ms for indexed_at comparisons (stored as INTEGER). */
function coerceIndexedAt(cond, value) {
    if (!INDEXED_AT_PROPS.has(cond.property))
        return value;
    if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
        const ms = Date.parse(value);
        return isNaN(ms) ? value : ms;
    }
    return value;
}
/** Push the parameter value(s) for a WHERE condition (handles LIKE wrapping and IN). */
export function pushWhereParam(params, cond) {
    if (cond.operator === 'IN') {
        const values = Array.isArray(cond.value) ? cond.value : [cond.value];
        for (const v of values)
            params.push(coerceIndexedAt(cond, v));
        return;
    }
    if (cond.operator === 'CONTAINS') {
        params.push(`%${cond.value}%`);
    }
    else if (cond.operator === 'STARTS WITH') {
        params.push(`${cond.value}%`);
    }
    else if (cond.operator === 'ENDS WITH') {
        params.push(`%${cond.value}`);
    }
    else {
        params.push(coerceIndexedAt(cond, cond.value));
    }
}
/**
 * Build the NOT EXISTS subquery fragment for a negated existence condition.
 * Returns a SQL fragment like:
 *   NOT EXISTS (SELECT 1 FROM edges WHERE target_id = n.id AND type = 'CALLS')
 *   NOT EXISTS (SELECT 1 FROM edges WHERE target_id = n.id AND type IN ('CALLS','ASYNC_CALLS'))
 *
 * Single-type: emits `type = 'X'` (byte-identical to the pre-Wave-3 output).
 * Multi-type:  emits `type IN ('T1','T2',...)`.
 * No type:     omits the type filter entirely.
 *
 * The fragment contains no bind parameters — the anchor id is referenced by column
 * name (e.g. `n.id`) so it stays correlated with the outer query row.
 */
export function buildNotExistsSql(cond) {
    const col = cond.anchorRole === 'target' ? 'target_id' : 'source_id';
    let typeFilter = '';
    if (cond.edgeTypes && cond.edgeTypes.length > 0) {
        if (cond.edgeTypes.length === 1) {
            // Preserve the pre-Wave-3 `type = 'X'` form for a single type.
            typeFilter = ` AND type = '${sanitizeIdentifier(cond.edgeTypes[0])}'`;
        }
        else {
            // Alternation: emit `type IN ('T1','T2',...)`.
            const inList = cond.edgeTypes.map((t) => `'${sanitizeIdentifier(t)}'`).join(',');
            typeFilter = ` AND type IN (${inList})`;
        }
    }
    return `NOT EXISTS (SELECT 1 FROM edges WHERE ${col} = ${sanitizeIdentifier(cond.anchorAlias)}.id${typeFilter})`;
}
/** Safety: check if a query contains write operations. */
export function isWriteQuery(query) {
    const upper = query.toUpperCase().trim();
    const writeKeywords = [
        'CREATE',
        'DELETE',
        'REMOVE',
        'SET ',
        'MERGE',
        'DROP',
        'INSERT',
        'UPDATE',
        'ALTER',
    ];
    return writeKeywords.some((kw) => upper.startsWith(kw) || upper.includes(` ${kw}`));
}
/** Sanitize an identifier to prevent SQL injection in inline values. */
export function sanitizeIdentifier(value) {
    return value.replace(/[^a-zA-Z0-9_]/g, '');
}
//# sourceMappingURL=cypherEngineSqlHelpers.js.map
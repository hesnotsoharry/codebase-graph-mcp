/**
 * cypherEngineSqlHelpers.ts — SQL building helpers extracted from CypherEngine
 * to keep cypherEngine.ts under the 300-line ESLint limit.
 */

import type { OrderByClause, WhereCondition } from './cypherEngineSupport';
import { PROP_TO_COLUMN } from './cypherEngineSupport';

/**
 * Build the SQL expression for a node property reference.
 * Returns `alias.column` for known SQL columns, or
 * `json_extract(alias.props, '$.key')` for any other key (props fall-through).
 */
export function resolveColumnExpression(sqlAlias: string, property: string): string {
  // eslint-disable-next-line security/detect-object-injection -- property is a validated identifier from the parsed query
  const sqlCol = PROP_TO_COLUMN[property];
  if (sqlCol) return `${sqlAlias}.${sqlCol}`;
  const safeKey = sanitizeIdentifier(property);
  return `json_extract(${sqlAlias}.props, '$.${safeKey}')`;
}

const LIKE_OPS = new Set(['CONTAINS', 'STARTS WITH', 'ENDS WITH']);
const PASSTHROUGH_OPS = new Set(['=', '<>', '>', '<', '>=', '<=', 'IN']);

/** Convert Cypher comparison operators to SQL operators. */
export function cypherOpToSql(op: string): string {
  if (LIKE_OPS.has(op)) return 'LIKE';
  if (PASSTHROUGH_OPS.has(op)) return op;
  return '=';
}

/** Build ORDER BY clause. Uses resolveColumnExpression so props.* keys sort correctly. */
export function buildOrderBy(orderBy: OrderByClause[]): string {
  if (orderBy.length === 0) return '';
  return orderBy
    .map((o) => `${resolveColumnExpression(o.alias, o.property)} ${o.direction}`)
    .join(', ');
}

/** Build the right-hand side of a WHERE condition: a single placeholder or an IN-list. */
export function buildWhereRhs(cond: WhereCondition): string {
  if (cond.operator === 'IN') {
    const values = Array.isArray(cond.value) ? cond.value : [cond.value];
    if (values.length === 0) return '(NULL)'; // empty IN matches nothing
    return `(${values.map(() => '?').join(', ')})`;
  }
  return '?';
}

/** Merge a new condition, collapsing OR pairs into a single expression. */
export function mergeCondition(
  conditions: string[],
  condStr: string,
  prevConjunction: 'AND' | 'OR' | null,
): void {
  if (prevConjunction === 'OR') {
    const lastCond = conditions.pop();
    conditions.push(lastCond ? `(${lastCond} OR ${condStr})` : condStr);
  } else {
    conditions.push(condStr);
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const INDEXED_AT_PROPS = new Set(['indexed_at', 'indexedAt']);

/** Coerce ISO date strings to epoch ms for indexed_at comparisons (stored as INTEGER). */
function coerceIndexedAt(cond: WhereCondition, value: unknown): unknown {
  if (!INDEXED_AT_PROPS.has(cond.property)) return value;
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
    const ms = Date.parse(value);
    return isNaN(ms) ? value : ms;
  }
  return value;
}

/** Push the parameter value(s) for a WHERE condition (handles LIKE wrapping and IN). */
export function pushWhereParam(params: unknown[], cond: WhereCondition): void {
  if (cond.operator === 'IN') {
    const values = Array.isArray(cond.value) ? cond.value : [cond.value];
    for (const v of values) params.push(coerceIndexedAt(cond, v));
    return;
  }
  if (cond.operator === 'CONTAINS') {
    params.push(`%${cond.value}%`);
  } else if (cond.operator === 'STARTS WITH') {
    params.push(`${cond.value}%`);
  } else if (cond.operator === 'ENDS WITH') {
    params.push(`%${cond.value}`);
  } else {
    params.push(coerceIndexedAt(cond, cond.value));
  }
}

/** Safety: check if a query contains write operations. */
export function isWriteQuery(query: string): boolean {
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
export function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '');
}

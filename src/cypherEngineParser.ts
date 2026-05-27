/**
 * cypherEngineParser.ts — Clause extraction and WHERE/ORDER BY parsing helpers
 * extracted from CypherEngine class methods.
 *
 * All functions are pure (no class state). They transform query strings into
 * structured types defined in cypherEngineSupport.ts.
 */

import type { OrderByClause, WhereCondition } from './cypherEngineSupport';

// ─── Clause extraction ────────────────────────────────────────────────────────
//
// WHERE-clause grammar supported:
//   <alias>.<prop>  {= | <> | < | > | <= | >= | CONTAINS | STARTS WITH | ENDS WITH}  <value>
//   <alias>.<prop>  IN  [<value>, <value>, ...]
//   labels(<alias>) IN [<value>, <value>, ...]   (sugar for <alias>.label IN [...])
// Multiple conditions joined by AND / OR.
// Anything that doesn't match these shapes throws — silent drop hides bugs.

const SUPPORTED_FEATURES_HINT =
  'Supported: MATCH, OPTIONAL MATCH, UNWIND [...] AS x, WHERE, RETURN, ORDER BY, LIMIT. ' +
  'NOT supported: WITH (pipeline operator). See get_graph_schema for the full feature list.';

/**
 * Throw a clear error if the query contains a top-level clause that the engine
 * does not support. Currently only WITH is permanently unsupported; OPTIONAL MATCH
 * and UNWIND are handled by dedicated parse paths.
 */
export function assertNoUnsupportedClauses(query: string): void {
  const upper = query.toUpperCase();
  // Strip Cypher string operators "STARTS WITH" and "ENDS WITH" before checking for
  // the bare WITH clause keyword, which would be a pipeline operator (not yet supported).
  const stripped = upper.replace(/(?:STARTS|ENDS)\s+WITH/g, '__OP__');
  if (/(?:^|\s)WITH\s/.test(stripped)) {
    throw new Error(
      `Cypher feature not supported by Ouroboros mini-engine: WITH (pipeline operator). ` +
        SUPPORTED_FEATURES_HINT,
    );
  }
}

/** All clause keywords used as boundaries, longest-first so OPTIONAL MATCH beats MATCH. */
const CLAUSE_BOUNDARIES = [
  'OPTIONAL MATCH',
  'ORDER BY',
  'MATCH',
  'WHERE',
  'RETURN',
  'LIMIT',
  'UNWIND',
];

/** Find the start index of `keyword` in `upper`, ensuring it is word-bounded. */
function findKeywordIndex(upper: string, keyword: string): number {
  let start = 0;
  while (start < upper.length) {
    const idx = upper.indexOf(keyword, start);
    if (idx === -1) return -1;
    const before = idx === 0 || /\s/.test(upper[idx - 1]);
    const after =
      idx + keyword.length >= upper.length || /[\s(]/.test(upper[idx + keyword.length]);
    if (before && after) return idx;
    start = idx + 1;
  }
  return -1;
}

/** Find the nearest clause boundary in `upper` (starting from position 0), skipping one boundary. */
function nextBoundaryIn(upper: string, skipBoundary: string): number {
  let min = Infinity;
  for (const b of CLAUSE_BOUNDARIES) {
    if (b === skipBoundary) continue;
    const pos = findKeywordIndex(upper, b);
    if (pos !== -1 && pos < min) min = pos;
  }
  return min;
}

/** Extract the content of a named clause from the query string. */
export function extractClause(query: string, clause: string): string | null {
  const upper = query.toUpperCase();
  const idx = findKeywordIndex(upper, clause);
  if (idx === -1) return null;

  // Plain MATCH must not be part of OPTIONAL MATCH
  if (clause === 'MATCH' && upper.slice(0, idx).trimEnd().endsWith('OPTIONAL')) return null;

  const afterClause = idx + clause.length;
  const tail = upper.slice(afterClause);
  const boundary = nextBoundaryIn(tail, clause);
  const content = query.slice(afterClause);
  return boundary === Infinity ? content.trim() : content.slice(0, boundary).trim();
}

/** Extract the OPTIONAL MATCH clause content, or null if absent. */
export function extractOptionalMatchClause(query: string): string | null {
  const upper = query.toUpperCase();
  const idx = findKeywordIndex(upper, 'OPTIONAL MATCH');
  if (idx === -1) return null;
  const afterClause = idx + 'OPTIONAL MATCH'.length;
  const tail = upper.slice(afterClause);
  const boundary = nextBoundaryIn(tail, 'OPTIONAL MATCH');
  const content = query.slice(afterClause);
  return boundary === Infinity ? content.trim() : content.slice(0, boundary).trim();
}

/** Extract the UNWIND clause content (list + AS alias), or null if absent. */
export function extractUnwindClause(query: string): string | null {
  const upper = query.toUpperCase();
  const idx = findKeywordIndex(upper, 'UNWIND');
  if (idx === -1) return null;
  const afterClause = idx + 'UNWIND'.length;
  const tail = upper.slice(afterClause);
  const boundary = nextBoundaryIn(tail, 'UNWIND');
  const content = query.slice(afterClause);
  return boundary === Infinity ? content.trim() : content.slice(0, boundary).trim();
}

// ─── WHERE parsing ────────────────────────────────────────────────────────────

/** Parse a value literal: 'string', number, or bare identifier. */
function parseValue(valueStr: string): string | number {
  const singleQuoted = /^'([^']*)'/.exec(valueStr);
  if (singleQuoted) return singleQuoted[1];

  const doubleQuoted = /^"([^"]*)"/.exec(valueStr);
  if (doubleQuoted) return doubleQuoted[1];

  const num = parseFloat(valueStr);
  if (!isNaN(num)) return num;

  return valueStr;
}

const WHERE_OPERATORS: Array<{ pattern: RegExp; op: string }> = [
  { pattern: /^STARTS\s+WITH\s+/i, op: 'STARTS WITH' },
  { pattern: /^ENDS\s+WITH\s+/i, op: 'ENDS WITH' },
  { pattern: /^CONTAINS\s+/i, op: 'CONTAINS' },
  { pattern: /^<>\s*/, op: '<>' },
  { pattern: /^>=\s*/, op: '>=' },
  { pattern: /^<=\s*/, op: '<=' },
  { pattern: /^>\s*/, op: '>' },
  { pattern: /^<\s*/, op: '<' },
  { pattern: /^=\s*/, op: '=' },
];

/** Parse the items inside an IN list literal (between [ and ]). */
function parseInListValues(listBody: string): (string | number)[] {
  const items: (string | number)[] = [];
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded quantifiers; input pre-capped by IN-list extraction
  const pattern = /'([^']*)'|"([^"]*)"|([+-]?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(listBody)) !== null) {
    if (m[1] !== undefined) items.push(m[1]);
    else if (m[2] !== undefined) items.push(m[2]);
    else if (m[3] !== undefined) items.push(parseFloat(m[3]));
  }
  return items;
}

/** Try to parse an IN-form condition (n.prop IN [...] or labels(n) IN [...]). */
function parseInCondition(condStr: string): WhereCondition | null {
  // labels(alias) IN [...]
  const labelsForm = /^labels\s*\(\s*(\w+)\s*\)\s+IN\s+\[([^\]]*)\]\s*$/i.exec(condStr);
  if (labelsForm) {
    const values = parseInListValues(labelsForm[2]);
    return {
      alias: labelsForm[1],
      property: 'label',
      operator: 'IN',
      value: values,
      conjunction: null,
    };
  }
  // alias.prop IN [...]
  const propForm = /^(\w+)\.(\w+)\s+IN\s+\[([^\]]*)\]\s*$/i.exec(condStr);
  if (propForm) {
    const values = parseInListValues(propForm[3]);
    return {
      alias: propForm[1],
      property: propForm[2],
      operator: 'IN',
      value: values,
      conjunction: null,
    };
  }
  return null;
}

/** Try to parse a scalar comparison condition (=, <>, <, >, CONTAINS, STARTS WITH, ENDS WITH).
 *  Anchored at the start of `condStr` so leading constructs like `NOT ...` or `EXISTS(...)`
 *  fall through and trigger the parser's "unsupported shape" error rather than being silently
 *  dropped (the pre-Wave-68b behavior). */
function parseScalarCondition(condStr: string): WhereCondition | null {
  const propMatch = /^(\w+)\.(\w+)/.exec(condStr.trim());
  if (!propMatch) return null;
  const alias = propMatch[1];
  const property = propMatch[2];
  const afterProp = condStr.trim().slice(propMatch[0].length).trim();
  for (const { pattern, op } of WHERE_OPERATORS) {
    const opMatch = pattern.exec(afterProp);
    if (opMatch) {
      const value = parseValue(afterProp.slice(opMatch[0].length).trim());
      return { alias, property, operator: op, value, conjunction: null };
    }
  }
  return null;
}

/** Parse a single WHERE condition. Recognizes IN-form first, then scalar comparisons. */
export function parseSingleCondition(condStr: string): WhereCondition | null {
  return parseInCondition(condStr) ?? parseScalarCondition(condStr);
}

type WherePart = { condition: string; conjunction: 'AND' | 'OR' | null };

/** Detect a top-level AND/OR boundary at position `i` of `whereStr`. */
function detectConjunctionAt(
  whereStr: string,
  i: number,
): { conj: 'AND' | 'OR'; length: number } | null {
  const rest = whereStr.slice(i);
  const andMatch = /^\s+AND\s+/i.exec(rest);
  if (andMatch) return { conj: 'AND', length: andMatch[0].length };
  const orMatch = /^\s+OR\s+/i.exec(rest);
  if (orMatch) return { conj: 'OR', length: orMatch[0].length };
  return null;
}

/** Update the bracket-nesting depth based on the character. */
function updateDepth(ch: string, depth: number): number {
  if (ch === '[' || ch === '(') return depth + 1;
  if (ch === ']' || ch === ')') return depth - 1;
  return depth;
}

/** Split a WHERE string on AND/OR while respecting bracket nesting (so `IN [a, b]` isn't split on the comma). */
function splitWhereParts(whereStr: string): WherePart[] {
  const parts: WherePart[] = [];
  let current = '';
  let depth = 0;
  let i = 0;
  while (i < whereStr.length) {
    // eslint-disable-next-line security/detect-object-injection -- i is a bounded loop index over a known string
    const ch = whereStr[i];
    depth = updateDepth(ch, depth);
    const conj = depth === 0 ? detectConjunctionAt(whereStr, i) : null;
    if (conj) {
      if (current.trim()) parts.push({ condition: current.trim(), conjunction: conj.conj });
      current = '';
      i += conj.length;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) parts.push({ condition: current.trim(), conjunction: null });
  return parts;
}

/** Parse WHERE clause into conditions. Throws on shapes the engine does not understand. */
export function parseWhere(whereStr: string): WhereCondition[] {
  const conditions: WhereCondition[] = [];
  for (const part of splitWhereParts(whereStr)) {
    const cond = parseSingleCondition(part.condition);
    if (!cond) {
      throw new Error(
        `Unsupported WHERE condition: "${part.condition}". Supported shapes: ` +
          `<alias>.<prop> {= | <> | < | > | <= | >= | CONTAINS | STARTS WITH | ENDS WITH} <value>; ` +
          `<alias>.<prop> IN [...]; labels(<alias>) IN [...].`,
      );
    }
    // The conjunction stored on a part is "what follows it" (AND/OR connects to the NEXT part).
    // The conjunction stored on a WhereCondition has the same meaning.
    cond.conjunction = part.conjunction;
    conditions.push(cond);
  }
  return conditions;
}

// ─── ORDER BY parsing ─────────────────────────────────────────────────────────

/** Parse ORDER BY clause into a list of sort directives. */
export function parseOrderBy(orderByStr: string): OrderByClause[] {
  const clauses: OrderByClause[] = [];
  for (const part of orderByStr.split(',').map((s) => s.trim())) {
    if (!part) continue;
    const desc = /\bDESC\b/i.test(part);
    const clean = part.replace(/\b(ASC|DESC)\b/gi, '').trim();
    const propMatch = /^(\w+)\.(\w+)$/.exec(clean);
    if (propMatch) {
      clauses.push({
        alias: propMatch[1],
        property: propMatch[2],
        direction: desc ? 'DESC' : 'ASC',
      });
    }
  }
  return clauses;
}

// ─── UNWIND parsing ───────────────────────────────────────────────────────────

/** Parse UNWIND clause content: `['v1','v2'] AS alias` → { values, alias }. */
export function parseUnwind(unwindStr: string): import('./cypherEngineSupport').UnwindClause {
  const m = /^\s*\[([^\]]*)\]\s+AS\s+(\w+)\s*$/i.exec(unwindStr);
  if (!m) {
    throw new Error(
      `Unsupported UNWIND syntax: "${unwindStr}". ` +
        `Expected: UNWIND ['v1', 'v2', ...] AS alias (literal list only).`,
    );
  }
  const values = parseInListValues(m[1]);
  return { values, alias: m[2] };
}


/**
 * cypherEngineParser.ts — Clause extraction and WHERE/ORDER BY parsing helpers
 * extracted from CypherEngine class methods.
 *
 * All functions are pure (no class state). They transform query strings into
 * structured types defined in cypherEngineSupport.ts.
 */
// ─── Clause extraction ────────────────────────────────────────────────────────
//
// WHERE-clause grammar supported:
//   <alias>.<prop>  {= | <> | < | > | <= | >= | CONTAINS | STARTS WITH | ENDS WITH}  <value>
//   <alias>.<prop>  IN  [<value>, <value>, ...]
//   labels(<alias>) IN [<value>, <value>, ...]   (sugar for <alias>.label IN [...])
// Multiple conditions joined by AND / OR.
// Anything that doesn't match these shapes throws — silent drop hides bugs.
/**
 * Throw a clear error if the query contains a top-level clause that the engine
 * does not support. OPTIONAL MATCH and UNWIND are handled by dedicated parse paths.
 * WITH is supported as a single-stage passthrough pipe (Wave 1 Phase 2).
 */
export function assertNoUnsupportedClauses(_query) {
    // No permanently-unsupported top-level clauses at this time.
    // Retain the function signature for callers; expansion point for future guards.
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
    'WITH',
];
/** Find the start index of `keyword` in `upper`, ensuring it is word-bounded. */
function findKeywordIndex(upper, keyword) {
    let start = 0;
    while (start < upper.length) {
        const idx = upper.indexOf(keyword, start);
        if (idx === -1)
            return -1;
        const before = idx === 0 || /\s/.test(upper[idx - 1]);
        const after = idx + keyword.length >= upper.length || /[\s(]/.test(upper[idx + keyword.length]);
        if (before && after) {
            // Special case: skip WITH when it appears as part of STARTS WITH or ENDS WITH
            if (keyword === 'WITH') {
                const preceding = upper.slice(0, idx).trimEnd();
                if (preceding.endsWith('STARTS') || preceding.endsWith('ENDS')) {
                    start = idx + 1;
                    continue;
                }
            }
            return idx;
        }
        start = idx + 1;
    }
    return -1;
}
/** Find the nearest clause boundary in `upper` (starting from position 0), skipping one boundary. */
function nextBoundaryIn(upper, skipBoundary) {
    let min = Infinity;
    for (const b of CLAUSE_BOUNDARIES) {
        if (b === skipBoundary)
            continue;
        const pos = findKeywordIndex(upper, b);
        if (pos !== -1 && pos < min)
            min = pos;
    }
    return min;
}
/** Extract the content of a named clause from the query string. */
export function extractClause(query, clause) {
    const upper = query.toUpperCase();
    const idx = findKeywordIndex(upper, clause);
    if (idx === -1)
        return null;
    // Plain MATCH must not be part of OPTIONAL MATCH
    if (clause === 'MATCH' && upper.slice(0, idx).trimEnd().endsWith('OPTIONAL'))
        return null;
    const afterClause = idx + clause.length;
    const tail = upper.slice(afterClause);
    const boundary = nextBoundaryIn(tail, clause);
    const content = query.slice(afterClause);
    return boundary === Infinity ? content.trim() : content.slice(0, boundary).trim();
}
/** Extract the OPTIONAL MATCH clause content, or null if absent. */
export function extractOptionalMatchClause(query) {
    const upper = query.toUpperCase();
    const idx = findKeywordIndex(upper, 'OPTIONAL MATCH');
    if (idx === -1)
        return null;
    const afterClause = idx + 'OPTIONAL MATCH'.length;
    const tail = upper.slice(afterClause);
    const boundary = nextBoundaryIn(tail, 'OPTIONAL MATCH');
    const content = query.slice(afterClause);
    return boundary === Infinity ? content.trim() : content.slice(0, boundary).trim();
}
/** Extract the UNWIND clause content (list + AS alias), or null if absent. */
export function extractUnwindClause(query) {
    const upper = query.toUpperCase();
    const idx = findKeywordIndex(upper, 'UNWIND');
    if (idx === -1)
        return null;
    const afterClause = idx + 'UNWIND'.length;
    const tail = upper.slice(afterClause);
    const boundary = nextBoundaryIn(tail, 'UNWIND');
    const content = query.slice(afterClause);
    return boundary === Infinity ? content.trim() : content.slice(0, boundary).trim();
}
/**
 * Extract the WITH clause content, or null if absent.
 * Strips "STARTS WITH" / "ENDS WITH" occurrences first so they don't trigger.
 * The WITH clause carries variable names to pass through: `a, b` or `a AS x, b`.
 */
export function extractWithClause(query) {
    // Strip "STARTS WITH" / "ENDS WITH" so their WITH token isn't matched.
    const sanitized = query.replace(/(?:STARTS|ENDS)\s+WITH/gi, '__STROP__');
    const upper = sanitized.toUpperCase();
    const idx = findKeywordIndex(upper, 'WITH');
    if (idx === -1)
        return null;
    const afterClause = idx + 'WITH'.length;
    const tail = upper.slice(afterClause);
    const boundary = nextBoundaryIn(tail, 'WITH');
    const content = sanitized.slice(afterClause);
    return boundary === Infinity ? content.trim() : content.slice(0, boundary).trim();
}
/**
 * Parse WITH clause content into the list of alias names being passed through.
 * Supports: `a`, `a, b`, `a AS x` (alias renaming is not supported; name-only is returned).
 * Returns the identifiers so the engine can validate they match MATCH-bound aliases.
 */
export function parseWithAliases(withStr) {
    return withStr
        .split(',')
        .map((part) => {
        // Strip any `AS <alias>` suffix — we only care about the source alias
        const asMatch = /^(\w+)\s+AS\s+\w+$/i.exec(part.trim());
        return asMatch ? asMatch[1] : part.trim().replace(/\s+.*/, '');
    })
        .filter(Boolean);
}
// ─── WHERE parsing ────────────────────────────────────────────────────────────
/** Parse a value literal: 'string', number, or bare identifier. */
function parseValue(valueStr) {
    const singleQuoted = /^'([^']*)'/.exec(valueStr);
    if (singleQuoted)
        return singleQuoted[1];
    const doubleQuoted = /^"([^"]*)"/.exec(valueStr);
    if (doubleQuoted)
        return doubleQuoted[1];
    const num = parseFloat(valueStr);
    if (!isNaN(num))
        return num;
    return valueStr;
}
const WHERE_OPERATORS = [
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
function parseInListValues(listBody) {
    const items = [];
    // eslint-disable-next-line security/detect-unsafe-regex -- bounded quantifiers; input pre-capped by IN-list extraction
    const pattern = /'([^']*)'|"([^"]*)"|([+-]?\d+(?:\.\d+)?)/g;
    let m;
    while ((m = pattern.exec(listBody)) !== null) {
        if (m[1] !== undefined)
            items.push(m[1]);
        else if (m[2] !== undefined)
            items.push(m[2]);
        else if (m[3] !== undefined)
            items.push(parseFloat(m[3]));
    }
    return items;
}
/** Try to parse an IN-form condition (n.prop IN [...] or labels(n) IN [...]). */
function parseInCondition(condStr) {
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
function parseScalarCondition(condStr) {
    const propMatch = /^(\w+)\.(\w+)/.exec(condStr.trim());
    if (!propMatch)
        return null;
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
/**
 * Parse a negated existence pattern: `NOT ()-[:TYPE]->(alias)` or `NOT (alias)-[:TYPE]->()`.
 * Returns a NegatedExistenceCondition if the shape matches, null otherwise.
 *
 * Supported shapes (anchored at start, case-insensitive):
 *   NOT ()-[:TYPE]->(alias)              — anchor is the target
 *   NOT ()<-[:TYPE]-(alias)              — anchor is the source (inbound edge)
 *   NOT (alias)-[:TYPE]->()              — anchor is the source
 *   NOT (alias)<-[:TYPE]-()              — anchor is the target (inbound edge)
 *   Alternation (Wave 3, negated-existence path only):
 *   NOT ()-[:T1|T2|...]->(alias)         — anchor is the target, multi-type negation
 *   Without edge type:
 *   NOT ()-->(alias) / NOT (alias)-->()  not supported currently (edge type required)
 *
 * Edge-type alternation `[:T1|T2|...]` is parsed into `edgeTypes: ['T1','T2',...]`.
 * A bare single type (`:CALLS`) produces `edgeTypes: ['CALLS']` — semantically identical
 * to the prior `edgeType: string | null` contract; SQL output is byte-identical.
 */
function parseNegatedExistence(condStr) {
    const upper = condStr.trim().toUpperCase();
    if (!upper.startsWith('NOT '))
        return null;
    const body = condStr.trim().slice(4).trim();
    /**
     * Convert a raw edge-type capture group (e.g. "CALLS" or "CALLS|ASYNC_CALLS") into the
     * normalized edgeTypes array, or null when no type was specified.
     * The pipe character used for alternation is stripped inside each token by sanitizeIdentifier
     * at SQL-emit time; here we only split on it.
     */
    function toEdgeTypes(raw) {
        if (!raw)
            return null;
        // Split on | and drop any empty tokens produced by leading/trailing pipes
        const types = raw.split('|').map((t) => t.trim()).filter(Boolean);
        return types.length > 0 ? types : null;
    }
    // Pattern: NOT ()-[:TYPE|...]->(alias)  — anchor = target
    const notTargetOut = 
    // eslint-disable-next-line security/detect-unsafe-regex -- [\w|]+ is bounded by the surrounding brackets; input capped by extractClause
    /^\(\s*\)\s*-\[\s*:?([\w|]+)?\s*\]\s*->\s*\(\s*(\w+)\s*\)$/.exec(body);
    if (notTargetOut) {
        return {
            kind: 'negated_existence',
            anchorAlias: notTargetOut[2],
            anchorRole: 'target',
            edgeTypes: toEdgeTypes(notTargetOut[1]),
            conjunction: null,
        };
    }
    // Pattern: NOT (alias)-[:TYPE|...]->()  — anchor = source
    const notSourceOut = 
    // eslint-disable-next-line security/detect-unsafe-regex -- [\w|]+ is bounded by the surrounding brackets; input capped by extractClause
    /^\(\s*(\w+)\s*\)\s*-\[\s*:?([\w|]+)?\s*\]\s*->\s*\(\s*\)$/.exec(body);
    if (notSourceOut) {
        return {
            kind: 'negated_existence',
            anchorAlias: notSourceOut[1],
            anchorRole: 'source',
            edgeTypes: toEdgeTypes(notSourceOut[2]),
            conjunction: null,
        };
    }
    // Pattern: NOT ()<-[:TYPE|...]-(alias)  — anchor = source
    const notSourceIn = 
    // eslint-disable-next-line security/detect-unsafe-regex -- [\w|]+ is bounded by the surrounding brackets; input capped by extractClause
    /^\(\s*\)\s*<-\[\s*:?([\w|]+)?\s*\]-\s*\(\s*(\w+)\s*\)$/.exec(body);
    if (notSourceIn) {
        return {
            kind: 'negated_existence',
            anchorAlias: notSourceIn[2],
            anchorRole: 'source',
            edgeTypes: toEdgeTypes(notSourceIn[1]),
            conjunction: null,
        };
    }
    // Pattern: NOT (alias)<-[:TYPE|...]-()  — anchor = target
    const notTargetIn = 
    // eslint-disable-next-line security/detect-unsafe-regex -- [\w|]+ is bounded by the surrounding brackets; input capped by extractClause
    /^\(\s*(\w+)\s*\)\s*<-\[\s*:?([\w|]+)?\s*\]-\s*\(\s*\)$/.exec(body);
    if (notTargetIn) {
        return {
            kind: 'negated_existence',
            anchorAlias: notTargetIn[1],
            anchorRole: 'target',
            edgeTypes: toEdgeTypes(notTargetIn[2]),
            conjunction: null,
        };
    }
    return null;
}
/** Parse a single WHERE condition. Recognizes IN-form first, then scalar comparisons, then negated existence. */
export function parseSingleCondition(condStr) {
    return parseInCondition(condStr) ?? parseScalarCondition(condStr) ?? parseNegatedExistence(condStr);
}
/** Detect a top-level AND/OR boundary at position `i` of `whereStr`. */
function detectConjunctionAt(whereStr, i) {
    const rest = whereStr.slice(i);
    const andMatch = /^\s+AND\s+/i.exec(rest);
    if (andMatch)
        return { conj: 'AND', length: andMatch[0].length };
    const orMatch = /^\s+OR\s+/i.exec(rest);
    if (orMatch)
        return { conj: 'OR', length: orMatch[0].length };
    return null;
}
/** Update the bracket-nesting depth based on the character. */
function updateDepth(ch, depth) {
    if (ch === '[' || ch === '(')
        return depth + 1;
    if (ch === ']' || ch === ')')
        return depth - 1;
    return depth;
}
/** Split a WHERE string on AND/OR while respecting bracket nesting (so `IN [a, b]` isn't split on the comma). */
function splitWhereParts(whereStr) {
    const parts = [];
    let current = '';
    let depth = 0;
    let i = 0;
    while (i < whereStr.length) {
        // eslint-disable-next-line security/detect-object-injection -- i is a bounded loop index over a known string
        const ch = whereStr[i];
        depth = updateDepth(ch, depth);
        const conj = depth === 0 ? detectConjunctionAt(whereStr, i) : null;
        if (conj) {
            if (current.trim())
                parts.push({ condition: current.trim(), conjunction: conj.conj });
            current = '';
            i += conj.length;
            continue;
        }
        current += ch;
        i++;
    }
    if (current.trim())
        parts.push({ condition: current.trim(), conjunction: null });
    return parts;
}
/** Parse WHERE clause into conditions. Throws on shapes the engine does not understand. */
export function parseWhere(whereStr) {
    const conditions = [];
    for (const part of splitWhereParts(whereStr)) {
        const cond = parseSingleCondition(part.condition);
        if (!cond) {
            throw new Error(`Unsupported WHERE condition: "${part.condition}". Supported shapes: ` +
                `<alias>.<prop> {= | <> | < | > | <= | >= | CONTAINS | STARTS WITH | ENDS WITH} <value>; ` +
                `<alias>.<prop> IN [...]; labels(<alias>) IN [...].`);
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
export function parseOrderBy(orderByStr) {
    const clauses = [];
    for (const part of orderByStr.split(',').map((s) => s.trim())) {
        if (!part)
            continue;
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
export function parseUnwind(unwindStr) {
    const m = /^\s*\[([^\]]*)\]\s+AS\s+(\w+)\s*$/i.exec(unwindStr);
    if (!m) {
        throw new Error(`Unsupported UNWIND syntax: "${unwindStr}". ` +
            `Expected: UNWIND ['v1', 'v2', ...] AS alias (literal list only).`);
    }
    const values = parseInListValues(m[1]);
    return { values, alias: m[2] };
}
//# sourceMappingURL=cypherEngineParser.js.map
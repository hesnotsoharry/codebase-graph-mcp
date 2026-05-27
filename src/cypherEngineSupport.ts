/**
 * cypherEngineSupport.ts — Helper types and functions extracted from cypherEngine.ts
 * to keep the main file under the max-lines limit.
 */

// ─── Internal AST types ───────────────────────────────────────────────────────

export type HopPattern = {
  kind: 'hop';
  left: { alias: string; label: string | null };
  right: { alias: string; label: string | null };
  edgeAlias: string | null;
  edgeType: string | null;
  direction: 'outbound' | 'inbound';
};

export type MatchPattern =
  | { kind: 'single'; alias: string; label: string | null }
  | HopPattern
  | {
      kind: 'varpath';
      left: { alias: string; label: string | null };
      right: { alias: string; label: string | null };
      edgeType: string | null;
      minHops: number;
      maxHops: number;
      direction: 'outbound' | 'inbound';
    }
  | { kind: 'multipat'; patterns: HopPattern[] };

export type WhereValue = string | number | (string | number)[];

export interface WhereCondition {
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
  isCount: boolean;
  isDistinct: boolean;
  /** OPTIONAL MATCH pattern — translates to LEFT JOIN. */
  optionalMatch: MatchPattern | null;
  /** UNWIND clause — literal list expansion via VALUES CTE. */
  unwind: UnwindClause | null;
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

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_ROWS = 200;

/** Map Cypher node properties to SQL column names */
export const PROP_TO_COLUMN: Record<string, string> = {
  name: 'name',
  label: 'label',
  file_path: 'file_path',
  filePath: 'file_path',
  start_line: 'start_line',
  startLine: 'start_line',
  end_line: 'end_line',
  endLine: 'end_line',
  qualified_name: 'qualified_name',
  qualifiedName: 'qualified_name',
  id: 'id',
  project: 'project',
};

// ─── parseMatch helpers ───────────────────────────────────────────────────────

const IDENT = '[A-Za-z_][A-Za-z0-9_$]*';
const VARPATH_OUT = new RegExp(
  `^\\((${IDENT})(?::(${IDENT}))?\\)\\s*-\\[\\s*:?(?:(${IDENT}))\\s*\\*\\s*(\\d+)\\s*\\.\\.\\s*(\\d+)\\s*\\]\\s*->\\s*\\((${IDENT})(?::(${IDENT}))?\\)$`,
  'i',
);
const VARPATH_IN = new RegExp(
  `^\\((${IDENT})(?::(${IDENT}))?\\)\\s*<-\\[\\s*:?(?:(${IDENT}))\\s*\\*\\s*(\\d+)\\s*\\.\\.\\s*(\\d+)\\s*\\]\\s*-\\s*\\((${IDENT})(?::(${IDENT}))?\\)$`,
  'i',
);
// Groups: 1=leftAlias, 2=leftLabel, 3=edgeAlias, 4=edgeType, 5=rightAlias, 6=rightLabel
// Edge bracket syntax handled: [], [r], [:TYPE], [r:TYPE]
const HOP_OUT =
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded quantifiers (\w*, \w+) prevent catastrophic backtracking; input capped by extractClause
  /\((\w*)(?::(\w+))?\)\s*-\[\s*(\w+)?\s*(?::(\w+))?\s*\]\s*->\s*\((\w*)(?::(\w+))?\)/i;
const HOP_IN =
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded quantifiers (\w*, \w+) prevent catastrophic backtracking; input capped by extractClause
  /\((\w*)(?::(\w+))?\)\s*<-\[\s*(\w+)?\s*(?::(\w+))?\s*\]\s*-\s*\((\w*)(?::(\w+))?\)/i;
// eslint-disable-next-line security/detect-unsafe-regex -- simple node pattern; no backtracking risk
const SINGLE_NODE = /\((\w*)(?::(\w+))?\)/i;

function tryVarpath(matchStr: string): MatchPattern | null {
  let m = VARPATH_OUT.exec(matchStr);
  if (m) {
    return {
      kind: 'varpath',
      left: { alias: m[1], label: m[2] || null },
      right: { alias: m[6], label: m[7] || null },
      edgeType: m[3] || null,
      minHops: parseInt(m[4], 10),
      maxHops: parseInt(m[5], 10),
      direction: 'outbound',
    };
  }
  m = VARPATH_IN.exec(matchStr);
  if (m) {
    return {
      kind: 'varpath',
      left: { alias: m[1], label: m[2] || null },
      right: { alias: m[6], label: m[7] || null },
      edgeType: m[3] || null,
      minHops: parseInt(m[4], 10),
      maxHops: parseInt(m[5], 10),
      direction: 'inbound',
    };
  }
  return null;
}

function hopFromMatch(m: RegExpExecArray, direction: 'outbound' | 'inbound'): HopPattern {
  return {
    kind: 'hop',
    left: { alias: m[1] || '_n0', label: m[2] || null },
    right: { alias: m[5] || '_n1', label: m[6] || null },
    edgeAlias: m[3] || null,
    edgeType: m[4] || null,
    direction,
  };
}

function tryHop(matchStr: string): MatchPattern | null {
  const mOut = HOP_OUT.exec(matchStr);
  if (mOut) return hopFromMatch(mOut, 'outbound');
  const mIn = HOP_IN.exec(matchStr);
  if (mIn) return hopFromMatch(mIn, 'inbound');
  return null;
}

/** Parse MATCH clause into a MatchPattern. */
export function parseMatch(matchStr: string): MatchPattern {
  const varpath = tryVarpath(matchStr);
  if (varpath) return varpath;

  const hop = tryHop(matchStr);
  if (hop) return hop;

  const m = SINGLE_NODE.exec(matchStr);
  if (m) {
    return { kind: 'single', alias: m[1], label: m[2] || null };
  }

  throw new Error(`Unsupported MATCH pattern: ${matchStr}`);
}

// ─── parseReturn helpers ──────────────────────────────────────────────────────

function parseCountReturn(
  working: string,
  isDistinct: boolean,
): { fields: ReturnField[]; isCount: boolean; isDistinct: boolean } | null {
  const countMatch = /^COUNT\s*\(\s*(.*)\s*\)$/i.exec(working);
  if (!countMatch) return null;

  const inner = countMatch[1].trim();
  if (inner === '*' || /^\w+$/.test(inner)) {
    return {
      fields: [
        {
          alias: inner === '*' ? '_all' : inner,
          property: '*',
          outputName: 'count',
        },
      ],
      isCount: true,
      isDistinct,
    };
  }
  return null;
}

function parseReturnField(fieldStr: string): ReturnField | null {
  const asMatch = /^(.+?)\s+AS\s+(\w+)$/i.exec(fieldStr);
  let expr: string;
  let outputName: string;

  if (asMatch) {
    expr = asMatch[1].trim();
    outputName = asMatch[2];
  } else {
    expr = fieldStr;
    outputName = fieldStr.replace('.', '_');
  }

  const propMatch = /^(\w+)\.(\w+)$/.exec(expr);
  if (propMatch) {
    return { alias: propMatch[1], property: propMatch[2], outputName };
  }
  if (/^\w+$/.test(expr)) {
    return { alias: expr, property: '*', outputName: expr };
  }
  const fnMatch = /^(\w+)\s*\(\s*(\w+)\s*\)$/.exec(expr);
  if (fnMatch) {
    const [, fnName, fnAlias] = fnMatch;
    if (fnName.toLowerCase() === 'labels') {
      return { alias: fnAlias, property: 'label', outputName: `labels_${fnAlias}` };
    }
    throw new Error(`unsupported function: ${fnName}`);
  }
  return null;
}

/** Parse RETURN clause into fields and detect COUNT/DISTINCT. */
export function parseReturn(returnStr: string): {
  fields: ReturnField[];
  isCount: boolean;
  isDistinct: boolean;
} {
  let isDistinct = false;
  let working = returnStr.trim();

  if (working.toUpperCase().startsWith('DISTINCT')) {
    isDistinct = true;
    working = working.slice(8).trim();
  }

  const countResult = parseCountReturn(working, isDistinct);
  if (countResult) return countResult;

  const fieldStrs = working.split(',').map((s) => s.trim());
  const fields: ReturnField[] = [];
  for (const fieldStr of fieldStrs) {
    if (!fieldStr) continue;
    const field = parseReturnField(fieldStr);
    if (field) fields.push(field);
  }

  return { fields, isCount: false, isDistinct };
}

// ─── singleHopSql helpers ─────────────────────────────────────────────────────

/** Build the JOIN condition for a single-hop query. */
export function buildHopJoinCondition(
  edgeAlias: string,
  leftAlias: string,
  rightAlias: string,
  direction: 'outbound' | 'inbound',
): string {
  if (direction === 'outbound') {
    return `${edgeAlias}.source_id = ${leftAlias}.id AND ${edgeAlias}.target_id = ${rightAlias}.id`;
  }
  return `${edgeAlias}.target_id = ${leftAlias}.id AND ${edgeAlias}.source_id = ${rightAlias}.id`;
}

export type {
  CypherResolvers,
  VarpathStartContext,
  VarpathTemplateOptions,
} from './cypherEngineVarpath';
export {
  buildVarpathEndConditions,
  buildVarpathSelectParts,
  buildVarpathSqlTemplate,
  buildVarpathStartConditions,
} from './cypherEngineVarpath';

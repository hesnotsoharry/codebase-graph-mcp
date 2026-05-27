/**
 * cypherEngine.ts — Minimal Cypher-subset query engine.
 *
 * Translates a limited subset of Cypher queries into SQL against the
 * nodes/edges tables in GraphDatabase. Pattern-based (not a full parser):
 * matches known query shapes and generates corresponding SQL.
 *
 * Supported patterns:
 * - MATCH (n:Label) WHERE ... RETURN ...
 * - MATCH (n:Label)-[:TYPE]->(m:Label) WHERE ... RETURN ...
 * - MATCH (n)-[:TYPE*1..3]->(m) WHERE ... RETURN ...
 * - MATCH (a)-[:X]->(b), (b)-[:Y]->(c) — multi-pattern
 * - OPTIONAL MATCH (a)-[:TYPE]->(b) — LEFT JOIN
 * - UNWIND ['a','b'] AS x — literal list expansion
 * - WHERE: =, <>, CONTAINS, STARTS WITH, ENDS WITH, >, <, >=, <=, AND, OR, IN
 * - RETURN with property access (n.name, n.file_path)
 * - ORDER BY, LIMIT, COUNT, DISTINCT
 *
 * Read-only: rejects anything that isn't a SELECT/WITH statement.
 * Results capped at 200 rows.
 */

import {
  buildMultiPatternSql,
  buildOptionalHopJoin,
  buildUnwindSql,
  parseMultiPattern,
} from './cypherEngineNewFeatures';
import {
  assertNoUnsupportedClauses,
  extractClause,
  extractOptionalMatchClause,
  extractUnwindClause,
  parseOrderBy,
  parseUnwind,
  parseWhere,
} from './cypherEngineParser';
import {
  buildOrderBy,
  buildWhereRhs,
  cypherOpToSql,
  isWriteQuery,
  mergeCondition,
  pushWhereParam,
  resolveColumnExpression,
  sanitizeIdentifier,
} from './cypherEngineSqlHelpers';
import type {
  CypherResolvers,
  HopPattern,
  MatchPattern,
  OrderByClause,
  ParsedQuery,
  ReturnField,
  UnwindClause,
  VarpathStartContext,
  WhereCondition,
} from './cypherEngineSupport';
import {
  buildHopJoinCondition,
  buildVarpathEndConditions,
  buildVarpathSelectParts,
  buildVarpathSqlTemplate,
  buildVarpathStartConditions,
  MAX_ROWS,
  parseMatch,
  parseReturn,
} from './cypherEngineSupport';
import type { GraphDatabase } from './graphDatabase';

export interface CypherQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
}

export class CypherEngine {
  constructor(
    private db: GraphDatabase,
    private projectName: string,
  ) {}

  execute(query: string): CypherQueryResult {
    const trimmed = query.trim();
    if (isWriteQuery(trimmed)) throw new Error('Only read-only queries are allowed');
    const parsed = this.parse(trimmed);
    const sql = this.toSql(parsed);
    const rawRows = this.db.rawQuery(sql.text, sql.params) as Record<string, unknown>[];
    const mappedRows = rawRows.map((row) => {
      const mapped: Record<string, unknown> = {};
      for (const field of parsed.returnFields) {
        mapped[field.outputName] = (row as Record<string, unknown>)[field.outputName] ?? null;
      }
      if (parsed.isCount && row['_count'] !== undefined) {
        const countKey = parsed.returnFields[0]?.outputName ?? 'count';
        // eslint-disable-next-line security/detect-object-injection -- countKey from validated RETURN fields
        mapped[countKey] = row['_count'];
      }
      return mapped;
    });
    return { columns: parsed.returnFields.map((f) => f.outputName), rows: mappedRows, total: mappedRows.length };
  }

  // ═══ Parser ════════════════════════════════════════════════════════════════

  private parseMatchPattern(matchClause: string | null): MatchPattern {
    if (!matchClause) return { kind: 'single', alias: '_n', label: null };
    const multiPatterns = parseMultiPattern(matchClause);
    if (multiPatterns) return { kind: 'multipat', patterns: multiPatterns };
    return parseMatch(matchClause);
  }

  private parse(query: string): ParsedQuery {
    assertNoUnsupportedClauses(query);
    const matchClause = extractClause(query, 'MATCH');
    const unwindStr = extractUnwindClause(query);
    if (!matchClause && !unwindStr) throw new Error('Query must contain a MATCH clause');
    const returnClause = extractClause(query, 'RETURN');
    if (!returnClause) throw new Error('Query must contain a RETURN clause');
    const match = this.parseMatchPattern(matchClause);
    const optionalMatchStr = extractOptionalMatchClause(query);
    const unwind: UnwindClause | null = unwindStr ? parseUnwind(unwindStr) : null;
    const whereClause = extractClause(query, 'WHERE');
    const where = whereClause ? parseWhere(whereClause) : [];
    const { fields: returnFields, isCount, isDistinct } = parseReturn(returnClause);
    const orderByClause = extractClause(query, 'ORDER BY');
    const orderBy = orderByClause ? parseOrderBy(orderByClause) : [];
    const limit = this.parseLimit(extractClause(query, 'LIMIT'));
    const optionalMatch = optionalMatchStr ? parseMatch(optionalMatchStr) : null;
    return { match, where, returnFields, orderBy, limit, isCount, isDistinct, optionalMatch, unwind };
  }

  private parseLimit(limitClause: string | null): number {
    if (!limitClause) return MAX_ROWS;
    const n = parseInt(limitClause.trim(), 10);
    return !isNaN(n) && n > 0 ? Math.min(n, MAX_ROWS) : MAX_ROWS;
  }

  // ═══ SQL Generator ══════════════════════════════════════════════════════════

  private toSql(parsed: ParsedQuery): { text: string; params: unknown[] } {
    if (parsed.unwind) {
      return buildUnwindSql({
        parsed,
        unwind: parsed.unwind,
        projectName: this.projectName,
        buildSelectColumns: (p, ...aliases) => this.buildSelectColumns(p, ...aliases),
        addWhereConditions: (w, c, pa) => this.addWhereConditions(w, c, pa),
      });
    }
    switch (parsed.match.kind) {
      case 'multipat': return buildMultiPatternSql({
        parsed,
        patterns: parsed.match.patterns,
        projectName: this.projectName,
        addWhereConditions: (w, c, pa) => this.addWhereConditions(w, c, pa),
      });
      case 'single': return this.singleNodeSql(parsed);
      case 'hop': return this.singleHopSql(parsed);
      case 'varpath': return this.varpathSql(parsed);
    }
  }

  private singleNodeSql(parsed: ParsedQuery): { text: string; params: unknown[] } {
    const match = parsed.match as Extract<MatchPattern, { kind: 'single' }>;
    if (match.label === 'Project') return this.singleProjectSql(parsed, match);
    const params: unknown[] = [];
    const alias = match.alias || '_n0';
    const optAliases = this.optionalMatchAliases(parsed.optionalMatch);
    const selectCols = this.buildSelectColumns(parsed, alias, ...optAliases);
    const conditions: string[] = [`${alias}.project = ?`];
    params.push(this.projectName);
    if (match.label) { conditions.push(`${alias}.label = ?`); params.push(match.label); }
    this.addWhereConditions(parsed.where, conditions, params);
    const optJoin = parsed.optionalMatch ? buildOptionalHopJoin(parsed.optionalMatch, alias) : '';
    const orderBy = buildOrderBy(parsed.orderBy);
    const distinct = parsed.isDistinct ? 'DISTINCT ' : '';
    const sql = [
      `SELECT ${distinct}${selectCols}`,
      `FROM nodes ${alias}`,
      optJoin,
      `WHERE ${conditions.join(' AND ')}`,
      orderBy ? `ORDER BY ${orderBy}` : '',
      `LIMIT ?`,
    ].filter(Boolean).join(' ');
    params.push(parsed.limit);
    return { text: sql, params };
  }

  private singleProjectSql(
    parsed: ParsedQuery,
    match: Extract<MatchPattern, { kind: 'single' }>,
  ): { text: string; params: unknown[] } {
    const alias = match.alias || '_p';
    const cols = parsed.isCount
      ? 'COUNT(*) AS _count'
      : parsed.returnFields.length === 0
        ? `${alias}.*`
        : parsed.returnFields
            .map((f) => f.property === '*' ? `${alias}.*` : `${alias}.${f.property} AS ${f.outputName}`)
            .join(', ');
    return { text: `SELECT ${cols} FROM projects ${alias} WHERE ${alias}.name = ? LIMIT ?`, params: [this.projectName, parsed.limit] };
  }

  private buildHopConditions(match: Extract<MatchPattern, { kind: 'hop' }>, params: unknown[]): string[] {
    const { left, right, edgeType } = match;
    const conditions: string[] = [`${left.alias}.project = ?`];
    params.push(this.projectName);
    if (left.label) { conditions.push(`${left.alias}.label = ?`); params.push(left.label); }
    if (right.label) { conditions.push(`${right.alias}.label = ?`); params.push(right.label); }
    if (edgeType) { conditions.push(`e.type = ?`); params.push(edgeType); }
    return conditions;
  }

  private singleHopSql(parsed: ParsedQuery): { text: string; params: unknown[] } {
    const match = parsed.match as Extract<MatchPattern, { kind: 'hop' }>;
    const params: unknown[] = [];
    const { left, right, edgeAlias: cypherEdgeAlias, direction } = match;
    const selectAliases = [left.alias, right.alias];
    if (cypherEdgeAlias) selectAliases.push(cypherEdgeAlias);
    const selectCols = this.buildSelectColumns(parsed, ...selectAliases);
    const joinCondition = buildHopJoinCondition('e', left.alias, right.alias, direction);
    const conditions = this.buildHopConditions(match, params);
    this.addWhereConditions(parsed.where, conditions, params);
    const optJoin = parsed.optionalMatch ? buildOptionalHopJoin(parsed.optionalMatch, left.alias) : '';
    const rightJoinCol = direction === 'outbound' ? 'e.target_id' : 'e.source_id';
    const orderBy = buildOrderBy(parsed.orderBy);
    const distinct = parsed.isDistinct ? 'DISTINCT ' : '';
    const sql = [
      `SELECT ${distinct}${selectCols}`,
      `FROM nodes ${left.alias}`,
      `JOIN edges e ON ${joinCondition}`,
      `JOIN nodes ${right.alias} ON ${right.alias}.id = ${rightJoinCol}`,
      optJoin,
      `WHERE ${conditions.join(' AND ')}`,
      orderBy ? `ORDER BY ${orderBy}` : '',
      `LIMIT ?`,
    ].filter(Boolean).join(' ');
    params.push(parsed.limit);
    return { text: sql, params };
  }

  private varpathSql(parsed: ParsedQuery): { text: string; params: unknown[] } {
    const match = parsed.match as Extract<MatchPattern, { kind: 'varpath' }>;
    const params: unknown[] = [];
    const { left, right, edgeType, minHops, maxHops, direction } = match;
    const resolvers: CypherResolvers = {
      resolveColumnExpression: (alias, p) => resolveColumnExpression(alias, p),
      cypherOpToSql: (op) => cypherOpToSql(op),
    };
    const startCtx: VarpathStartContext = { left, projectName: this.projectName };
    const startConditions = buildVarpathStartConditions(startCtx, parsed.where, params, resolvers);
    const endConditions = buildVarpathEndConditions(right, parsed.where, params, resolvers);
    const rawSelectParts = buildVarpathSelectParts(parsed.returnFields, left.alias, right.alias, (alias, p) => resolveColumnExpression(alias, p));
    const typeFilter = edgeType ? `AND e.type = '${sanitizeIdentifier(edgeType)}'` : '';
    const nextNode = direction === 'outbound' ? 'e.target_id' : 'e.source_id';
    const edgeJoin = direction === 'outbound'
      ? `e.source_id = r.current_id ${typeFilter}`
      : `e.target_id = r.current_id ${typeFilter}`;
    const endWhere = endConditions.length > 0 ? `AND ${endConditions.join(' AND ')}` : '';
    const selectParts = rawSelectParts.length === 0 ? ['n_end.*'] : rawSelectParts;
    const sql = buildVarpathSqlTemplate({ startConditions, nextNode, edgeJoin, endWhere, distinct: parsed.isDistinct ? 'DISTINCT ' : '', selectParts, orderBy: buildOrderBy(parsed.orderBy) });
    params.push(maxHops, minHops, maxHops, parsed.limit);
    return { text: sql, params };
  }

  // ═══ Shared helpers ══════════════════════════════════════════════════════════

  /** Return the right-side node alias(es) from an optional match pattern, for SELECT inclusion. */
  private optionalMatchAliases(om: MatchPattern | null): string[] {
    if (!om || om.kind !== 'hop') return [];
    return [om.right.alias || '_opt_r'];
  }

  private buildSelectColumns(parsed: ParsedQuery, ...availableAliases: string[]): string {
    if (parsed.isCount) return 'COUNT(*) AS _count';
    const edgeAliases = availableAliases.slice(2);
    const cols: string[] = [];
    for (const field of parsed.returnFields) {
      const expr = this.buildSelectColumnExpr(field, availableAliases, edgeAliases);
      if (expr) cols.push(expr);
    }
    return cols.length > 0 ? cols.join(', ') : `${availableAliases[0]}.*`;
  }

  private buildSelectColumnExpr(field: ReturnField, availableAliases: string[], edgeAliases: string[]): string {
    const edgeColumns = new Set(['id', 'project', 'source_id', 'target_id', 'type', 'confidence']);
    const isEdge = edgeAliases.includes(field.alias);
    const sqlAlias = isEdge ? 'e' : field.alias;
    if (field.property === '*') return availableAliases.includes(field.alias) ? `${sqlAlias}.*` : '';
    if (isEdge) {
      const safeKey = sanitizeIdentifier(field.property);
      const ref = edgeColumns.has(field.property) ? `${sqlAlias}.${field.property}` : `json_extract(${sqlAlias}.props, '$.${safeKey}')`;
      return `${ref} AS ${field.outputName}`;
    }
    if (!availableAliases.includes(field.alias)) {
      const safeKey = sanitizeIdentifier(field.property);
      return `json_extract(${field.alias}.props, '$.${safeKey}') AS ${field.outputName}`;
    }
    return `${resolveColumnExpression(sqlAlias, field.property)} AS ${field.outputName}`;
  }

  private addWhereConditions(where: WhereCondition[], conditions: string[], params: unknown[]): void {
    let prevConjunction: 'AND' | 'OR' | null = null;
    for (const cond of where) {
      const expression = resolveColumnExpression(cond.alias, cond.property);
      const sqlOp = cypherOpToSql(cond.operator);
      const rhs = buildWhereRhs(cond);
      mergeCondition(conditions, `${expression} ${sqlOp} ${rhs}`, prevConjunction);
      pushWhereParam(params, cond);
      prevConjunction = cond.conjunction;
    }
  }
}

export type { HopPattern, MatchPattern, OrderByClause, ParsedQuery, ReturnField, WhereCondition };

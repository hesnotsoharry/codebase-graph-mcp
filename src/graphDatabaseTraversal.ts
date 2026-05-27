/**
 * graphDatabaseTraversal.ts — BFS traversal, degree queries, and degree-filtered
 * node lookup helpers extracted from graphDatabaseHelpers.ts.
 *
 * All functions accept a `db` parameter (better-sqlite3 Database instance) so
 * they can be used as stateless helpers outside the GraphDatabase class.
 */

import type Database from 'better-sqlite3';

import type { GraphNode, NodeSearchResult } from './graphDatabaseTypes';

// ─── BFS traversal ────────────────────────────────────────────────────────────

export interface BfsOptions {
  startNodeId: string;
  edgeTypes: string[];
  direction: 'outbound' | 'inbound';
  maxDepth: number;
  maxNodes?: number;
  minConfidence?: number; // 0.0–1.0; default 0 (no filtering)
}

/** Build the BFS SQL and run it. Returns rows with id/depth/path. */
export function runBfsTraversal(
  db: Database.Database,
  opts: BfsOptions,
): Array<{ id: string; depth: number; path: string[] }> {
  const { startNodeId, edgeTypes, direction, maxDepth, maxNodes = 200, minConfidence } = opts;
  const typeList = edgeTypes.map((t) => `'${t}'`).join(',');
  const confidenceClause =
    minConfidence !== undefined && minConfidence > 0 ? ` AND e.confidence >= ${minConfidence}` : '';
  const edgeCondition =
    direction === 'outbound'
      ? `e.source_id = r.id AND e.type IN (${typeList})${confidenceClause}`
      : `e.target_id = r.id AND e.type IN (${typeList})${confidenceClause}`;
  const nextNode = direction === 'outbound' ? 'e.target_id' : 'e.source_id';

  // Cycle detection: per-row visited set stored in `path` as a JSON array.
  // Anchor seeds with json_array(start_id). Recursive step appends the next
  // node via json_insert at '$[#]' (SQLite "next array index" — supported since
  // 3.31.0, well within better-sqlite3@12.8.0's bundled SQLite 3.53.x).
  // Membership guard uses NOT EXISTS over json_each, which performs structural
  // membership — immune to the prefix-collision hazard of the old LIKE pattern
  // (e.g. 'src.a' and 'src.auth' are distinct in a JSON array but not in a
  // LIKE '%src.a%' check). Wave 20 — graphDatabaseTraversal.ts.
  const sql = `
    WITH RECURSIVE reachable(id, depth, path) AS (
      SELECT ?, 0, json_array(?)
      UNION ALL
      SELECT ${nextNode}, r.depth + 1, json_insert(r.path, '$[#]', ${nextNode})
      FROM reachable r
      JOIN edges e ON ${edgeCondition}
      WHERE r.depth < ?
        AND NOT EXISTS (SELECT 1 FROM json_each(r.path) WHERE value = ${nextNode})
    )
    SELECT id, depth, path FROM reachable
    WHERE depth > 0
    ORDER BY depth
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(startNodeId, startNodeId, maxDepth, maxNodes) as Array<{
    id: string;
    depth: number;
    path: string;
  }>;
  return rows.map((r) => ({ id: r.id, depth: r.depth, path: JSON.parse(r.path) as string[] }));
}

// ─── Single-node degree query ─────────────────────────────────────────────────

/** Build degree count SQL and run it for a single node. */
export function runNodeDegreeQuery(
  db: Database.Database,
  nodeId: string,
  type: string | undefined,
  direction: 'in' | 'out' | 'both',
): number {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (direction === 'in') {
    conditions.push('e.target_id = ?');
    params.push(nodeId);
  } else if (direction === 'out') {
    conditions.push('e.source_id = ?');
    params.push(nodeId);
  } else {
    conditions.push('(e.source_id = ? OR e.target_id = ?)');
    params.push(nodeId, nodeId);
  }

  if (type) {
    conditions.push('e.type = ?');
    params.push(type);
  }

  const sql = `SELECT COUNT(*) as count FROM edges e WHERE ${conditions.join(' AND ')}`;
  const row = db.prepare(sql).get(...params) as { count: number };
  return row.count;
}

// ─── getNodesByDegree helpers ─────────────────────────────────────────────────

/** Options for the getNodesByDegree query. */
export interface NodesByDegreeOptions {
  label?: string;
  type?: string;
  direction: 'in' | 'out' | 'both';
  minDegree?: number;
  maxDegree?: number;
  excludeEntryPoints?: boolean;
  limit?: number;
  offset?: number;
}

/** Build the degree sub-expression for a node-scoped query. */
export function buildNodeDegreeExpr(direction: 'in' | 'out' | 'both', type?: string): string {
  const typeClause = type ? ' AND e.type = ?' : '';
  if (direction === 'in') {
    return `(SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id${typeClause})`;
  }
  if (direction === 'out') {
    return `(SELECT COUNT(*) FROM edges e WHERE e.source_id = n.id${typeClause})`;
  }
  return `(SELECT COUNT(*) FROM edges e WHERE (e.source_id = n.id OR e.target_id = n.id)${typeClause})`;
}

/** Add min/max degree conditions with per-use type param bindings. */
export function addNodeDegreeConditions(
  options: NodesByDegreeOptions,
  conditions: string[],
  params: unknown[],
): void {
  const degreeExpr = buildNodeDegreeExpr(options.direction, options.type);

  if (options.minDegree !== undefined) {
    if (options.type) params.push(options.type);
    conditions.push(`${degreeExpr} >= ?`);
    params.push(options.minDegree);
  }
  if (options.maxDegree !== undefined) {
    if (options.type) params.push(options.type);
    conditions.push(`${degreeExpr} <= ?`);
    params.push(options.maxDegree);
  }
}

/** Execute getNodesByDegree query with degree filtering. */
export function runGetNodesByDegree(
  db: Database.Database,
  project: string,
  options: NodesByDegreeOptions,
  rowToNode: (row: unknown) => GraphNode,
): NodeSearchResult {
  const { label, excludeEntryPoints } = options;
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;

  const conditions: string[] = ['n.project = ?'];
  const params: unknown[] = [project];

  if (label) {
    conditions.push('n.label = ?');
    params.push(label);
  }
  if (excludeEntryPoints) {
    conditions.push("json_extract(n.props, '$.is_entry_point') != 1");
  }

  addNodeDegreeConditions(options, conditions, params);

  const where = `WHERE ${conditions.join(' AND ')}`;
  const countRow = db.prepare(`SELECT COUNT(*) as total FROM nodes n ${where}`).get(...params) as {
    total: number;
  };
  const rows = db
    .prepare(`SELECT * FROM nodes n ${where} ORDER BY n.name LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  return {
    nodes: rows.map(rowToNode),
    total: countRow.total,
    has_more: offset + limit < countRow.total,
  };
}

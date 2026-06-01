/**
 * graphDatabaseHelpers.ts — Helper functions extracted from graphDatabase.ts
 * to keep the main file under the 300-line limit.
 *
 * Contains: database path resolution, prepared statement builders,
 * row mappers, search/traversal query runners, and query condition helpers.
 * SQL DDL lives in graphDatabaseSchema.ts.
 */
export { SCHEMA_SQL } from './graphDatabaseSchema.js';
// ─── Database path ────────────────────────────────────────────────────────────
// NOTE: The standalone package does not compute a DB path — callers supply it.
// This function is removed; use the `dbPath` constructor parameter on GraphDatabase
// (or pass the path directly to openDatabase). The caller (MCP entry point) derives
// the path from the project root, e.g.:
//   path.join(os.homedir(), '.codebase-graph', hash(rootPath).slice(0, 8), 'graph.db')
// ─── Prepared Statement preparation ──────────────────────────────────────────
/** Build the core node/edge CRUD statements. */
export function buildCoreStatements(db) {
    return {
        insertNode: db.prepare(`
      INSERT OR REPLACE INTO nodes (id, project, label, name, qualified_name, file_path, start_line, end_line, props)
      VALUES (@id, @project, @label, @name, @qualified_name, @file_path, @start_line, @end_line, @props)
    `),
        insertEdge: db.prepare(`
      INSERT OR REPLACE INTO edges (project, source_id, target_id, type, props, confidence)
      VALUES (@project, @source_id, @target_id, @type, @props, @confidence)
    `),
        deleteNode: db.prepare('DELETE FROM nodes WHERE id = ?'),
        deleteEdge: db.prepare('DELETE FROM edges WHERE id = ?'),
        getNode: db.prepare('SELECT * FROM nodes WHERE id = ?'),
        getEdgesBySource: db.prepare('SELECT * FROM edges WHERE source_id = ?'),
        getEdgesBySourceAndType: db.prepare('SELECT * FROM edges WHERE source_id = ? AND type = ?'),
        getEdgesByTarget: db.prepare('SELECT * FROM edges WHERE target_id = ?'),
        getEdgesByTargetAndType: db.prepare('SELECT * FROM edges WHERE target_id = ? AND type = ?'),
        updateNodeProps: db.prepare('UPDATE nodes SET props = @props WHERE id = @id'),
    };
}
/** Build file-hash and project statements. */
export function buildHashAndProjectStatements(db) {
    return {
        upsertFileHash: db.prepare(`
      INSERT OR REPLACE INTO file_hashes (project, rel_path, content_hash, mtime_ns, size)
      VALUES (@project, @rel_path, @content_hash, @mtime_ns, @size)
    `),
        getFileHash: db.prepare('SELECT * FROM file_hashes WHERE project = ? AND rel_path = ?'),
        getAllFileHashes: db.prepare('SELECT * FROM file_hashes WHERE project = ?'),
        deleteFileHashes: db.prepare('DELETE FROM file_hashes WHERE project = ?'),
        deleteFileHash: db.prepare('DELETE FROM file_hashes WHERE project = ? AND rel_path = ?'),
        upsertProject: db.prepare(`
      INSERT INTO projects (name, root_path, indexed_at, node_count, edge_count)
      VALUES (@name, @root_path, @indexed_at, @node_count, @edge_count)
      ON CONFLICT(name) DO UPDATE SET
        root_path  = excluded.root_path,
        indexed_at = excluded.indexed_at,
        node_count = excluded.node_count,
        edge_count = excluded.edge_count
    `),
        getProject: db.prepare('SELECT * FROM projects WHERE name = ?'),
        listProjects: db.prepare('SELECT * FROM projects ORDER BY name'),
        deleteProject: db.prepare('DELETE FROM projects WHERE name = ?'),
    };
}
/** Build search, label, stats, and ADR statements. */
export function buildSearchAndStatsStatements(db) {
    return {
        countNodes: db.prepare('SELECT COUNT(*) as count FROM nodes WHERE project = ?'),
        countEdges: db.prepare('SELECT COUNT(*) as count FROM edges WHERE project = ?'),
        searchNodesFts: db.prepare(`
      SELECT n.* FROM nodes n
      JOIN nodes_fts fts ON n.rowid = fts.rowid
      WHERE nodes_fts MATCH ?
      LIMIT ?
    `),
        getNodesByLabel: db.prepare('SELECT * FROM nodes WHERE project = ? AND label = ?'),
        getNodesByFile: db.prepare('SELECT * FROM nodes WHERE project = ? AND file_path = ?'),
        deleteNodesByProject: db.prepare('DELETE FROM nodes WHERE project = ?'),
        deleteNodesByFile: db.prepare('DELETE FROM nodes WHERE project = ? AND file_path = ?'),
        deleteEdgesByProject: db.prepare('DELETE FROM edges WHERE project = ?'),
        upsertAdr: db.prepare(`
      INSERT OR REPLACE INTO project_summaries (project, summary, source_hash, created_at, updated_at)
      VALUES (@project, @summary, @source_hash, @created_at, @updated_at)
    `),
        getAdr: db.prepare('SELECT * FROM project_summaries WHERE project = ?'),
        deleteAdr: db.prepare('DELETE FROM project_summaries WHERE project = ?'),
        getNodeLabelCounts: db.prepare('SELECT label, COUNT(*) as count FROM nodes WHERE project = ? GROUP BY label'),
        getEdgeTypeCounts: db.prepare('SELECT type, COUNT(*) as count FROM edges WHERE project = ? GROUP BY type'),
        getRelationshipPatterns: db.prepare(`
      SELECT DISTINCT
        ns.label || ' -[' || e.type || ']-> ' || nt.label AS pattern
      FROM edges e
      JOIN nodes ns ON e.source_id = ns.id
      JOIN nodes nt ON e.target_id = nt.id
      WHERE e.project = ?
      ORDER BY pattern
    `),
    };
}
// ─── searchNodes SQL builders ─────────────────────────────────────────────────
/** Build base conditions from simple NodeFilter properties. */
export function buildBaseConditions(filter, conditions, params) {
    if (filter.project) {
        conditions.push('n.project = ?');
        params.push(filter.project);
    }
    if (filter.label) {
        conditions.push('n.label = ?');
        params.push(filter.label);
    }
    if (filter.namePattern) {
        if (filter.caseSensitive) {
            conditions.push('n.name LIKE ?');
        }
        else {
            conditions.push('LOWER(n.name) LIKE LOWER(?)');
        }
        params.push(`%${filter.namePattern}%`);
    }
    if (filter.filePath) {
        conditions.push('n.file_path LIKE ?');
        params.push(`%${filter.filePath}%`);
    }
}
/** Build a degree sub-expression for the given direction and edge type. */
export function buildDegreeExpr(edgeDir, edgeType) {
    const typeClause = edgeType ? ' AND e.type = ?' : '';
    if (edgeDir === 'inbound') {
        return `(SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id${typeClause})`;
    }
    if (edgeDir === 'outbound') {
        return `(SELECT COUNT(*) FROM edges e WHERE e.source_id = n.id${typeClause})`;
    }
    return `(SELECT COUNT(*) FROM edges e WHERE (e.source_id = n.id OR e.target_id = n.id)${typeClause})`;
}
/** Add degree conditions to the WHERE clause. */
export function addDegreeConditions(filter, conditions, params) {
    if (filter.minDegree === undefined && filter.maxDegree === undefined)
        return;
    const edgeDir = filter.direction ?? 'both';
    const edgeType = filter.relationship;
    if (filter.minDegree !== undefined) {
        const degreeExpr = buildDegreeExpr(edgeDir, edgeType);
        if (edgeType)
            params.push(edgeType);
        conditions.push(`${degreeExpr} >= ?`);
        params.push(filter.minDegree);
    }
    if (filter.maxDegree !== undefined) {
        const degreeExpr = buildDegreeExpr(edgeDir, edgeType);
        if (edgeType)
            params.push(edgeType);
        conditions.push(`${degreeExpr} <= ?`);
        params.push(filter.maxDegree);
    }
}
// ─── getNodesByDegree helpers ─────────────────────────────────────────────────
// ─── Row-to-type mappers ──────────────────────────────────────────────────────
export function rowToNode(row) {
    const r = row;
    return {
        id: r.id,
        project: r.project,
        label: r.label,
        name: r.name,
        qualified_name: r.qualified_name,
        file_path: r.file_path,
        start_line: r.start_line,
        end_line: r.end_line,
        props: JSON.parse(r.props),
    };
}
export function rowToEdge(row) {
    const r = row;
    return {
        id: r.id,
        project: r.project,
        source_id: r.source_id,
        target_id: r.target_id,
        type: r.type,
        props: JSON.parse(r.props),
        confidence: typeof r.confidence === 'number' ? r.confidence : 1.0,
    };
}
export function rowToProject(row) {
    return {
        name: row.name,
        root_path: row.root_path,
        indexed_at: row.indexed_at,
        node_count: row.node_count,
        edge_count: row.edge_count,
    };
}
export function rowToFileHash(r) {
    return {
        project: r.project,
        rel_path: r.rel_path,
        content_hash: r.content_hash,
        mtime_ns: r.mtime_ns,
        size: r.size,
    };
}
export function rowToAdr(r) {
    return {
        project: r.project,
        summary: r.summary,
        source_hash: r.source_hash,
        created_at: r.created_at,
        updated_at: r.updated_at,
    };
}
// ─── Row aggregation helpers ──────────────────────────────────────────────────
/** Map label-count rows to a typed record. */
export function aggregateNodeLabelCounts(rows) {
    return rows.reduce((acc, row) => {
        acc[row.label] = row.count;
        return acc;
    }, {});
}
/** Map type-count rows to a typed record. */
export function aggregateEdgeTypeCounts(rows) {
    return rows.reduce((acc, row) => {
        acc[row.type] = row.count;
        return acc;
    }, {});
}
// ─── searchNodes / getNodesByDegree body helpers ──────────────────────────────
/** Execute the searchNodes query against the DB and return results + pagination. */
export function runSearchNodes(db, filter, rowToNode) {
    const conditions = [];
    const params = [];
    buildBaseConditions(filter, conditions, params);
    addDegreeConditions(filter, conditions, params);
    if (filter.excludeEntryPoints) {
        conditions.push("json_extract(n.props, '$.is_entry_point') != 1");
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;
    const countSql = `SELECT COUNT(*) as total FROM nodes n ${where}`;
    const countRow = db.prepare(countSql).get(...params);
    const dataSql = `SELECT * FROM nodes n ${where} ORDER BY n.name LIMIT ? OFFSET ?`;
    const rows = db.prepare(dataSql).all(...params, limit, offset);
    return {
        nodes: rows.map(rowToNode),
        total: countRow.total,
        has_more: offset + limit < countRow.total,
    };
}
/**
 * 3-tier ranked symbol search: exact (rank 0) > prefix (rank 1) > substring (rank 2).
 * Tiers are mutually exclusive — no duplicates across tiers.
 */
export function runSearchNodesRanked(db, project, query, limit) {
    const sql = `
    SELECT *, 0 AS rank FROM nodes WHERE project = ? AND name = ?
    UNION ALL
    SELECT *, 1 AS rank FROM nodes WHERE project = ? AND name LIKE ? || '%' AND name != ?
    UNION ALL
    SELECT *, 2 AS rank FROM nodes WHERE project = ? AND name LIKE '%' || ? || '%' AND name NOT LIKE ? || '%' AND name != ?
    ORDER BY rank, name
    LIMIT ?
  `;
    const rows = db
        .prepare(sql)
        .all(project, query, project, query, query, project, query, query, query, limit);
    return rows.map((row) => ({ ...rowToNode(row), rank: row.rank }));
}
export { addNodeDegreeConditions, buildNodeDegreeExpr, runBfsTraversal, runGetNodesByDegree, runNodeDegreeQuery, } from './graphDatabaseTraversal.js';
//# sourceMappingURL=graphDatabaseHelpers.js.map
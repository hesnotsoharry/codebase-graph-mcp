/**
 * graphDatabase.ts — SQLite property graph store backed by better-sqlite3.
 *
 * Manages the lifecycle of the database, schema creation, and CRUD operations
 * for nodes and edges. All operations are synchronous (better-sqlite3's design).
 */
import Database from 'better-sqlite3';
import { aggregateEdgeTypeCounts, aggregateNodeLabelCounts, buildCoreStatements, buildHashAndProjectStatements, buildSearchAndStatsStatements, deleteOutboundEdgesOfType as deleteOutboundEdgesOfTypeHelper, rowToAdr, rowToEdge, rowToFileHash, rowToNode, rowToProject, runBfsTraversal, runGetNodesByDegree, runNodeDegreeQuery, runSearchNodes, runSearchNodesRanked, SCHEMA_SQL, } from './graphDatabaseHelpers.js';
import os from 'os';
import path from 'path';
/** Default DB path for the standalone package (no Electron dependency). */
function defaultDbPath() {
    return path.join(os.homedir(), '.codebase-graph', 'graph.db');
}
import { migrateToV1, migrateToV2 } from './graphDatabaseMigrations.js';
import { SCHEMA_VERSION } from './graphDatabaseSchema.js';
import { detectChangesForSession, invalidateCatalogHash, pruneProject, verifyCatalogHash, writeCatalogHash, } from './graphDatabaseSession.js';
// ─── GraphDatabase class ─────────────────────────────────────────────────────
export class GraphDatabase {
    db;
    stmts;
    constructor(dbPath, opts = {}) {
        const p = dbPath ?? defaultDbPath();
        const ro = opts.readonly === true;
        this.db = ro ? new Database(p, { readonly: true, fileMustExist: true }) : new Database(p);
        this.applyPragmas(ro);
        if (!ro)
            this.createSchema();
        this.prepareStatements();
    }
    applyPragmas(ro) {
        if (!ro)
            this.db.pragma('journal_mode = WAL');
        if (!ro)
            this.db.pragma('synchronous = NORMAL');
        const pragmas = ['cache_size = -32000', 'temp_store = MEMORY', 'mmap_size = 134217728', 'foreign_keys = ON', 'busy_timeout = 5000'];
        for (const p of pragmas)
            this.db.pragma(p);
    }
    createSchema() {
        this.db.exec(SCHEMA_SQL);
        this.runMigrations();
    }
    runMigrations() {
        const current = this.db.pragma('user_version', { simple: true }) ?? 0;
        if (current >= SCHEMA_VERSION)
            return;
        const txn = this.db.transaction(() => {
            if (current < 1)
                migrateToV1(this.db);
            if (current < 2)
                migrateToV2(this.db);
            this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
        });
        txn();
    }
    prepareStatements() {
        this.stmts = {
            ...buildCoreStatements(this.db),
            ...buildHashAndProjectStatements(this.db),
            ...buildSearchAndStatsStatements(this.db),
        };
    }
    // ─── Project operations ─────────────────────────────────────────────────
    upsertProject(project) {
        this.stmts.upsertProject.run(project);
    }
    getProject(name) {
        const row = this.stmts.getProject.get(name);
        return row ? rowToProject(row) : null;
    }
    listProjects() {
        return this.stmts.listProjects.all().map(rowToProject);
    }
    deleteProject(name) {
        this.stmts.deleteProject.run(name);
    }
    touchProjectOpened(name) {
        this.db.prepare('UPDATE projects SET last_opened_at = ? WHERE name = ?').run(Date.now(), name);
    }
    getProjectLastOpened(name) {
        const row = this.db.prepare('SELECT last_opened_at FROM projects WHERE name = ?').get(name);
        return row ? row.last_opened_at : null;
    }
    listAllProjects() {
        return this.db.prepare('SELECT name, last_opened_at FROM projects ORDER BY name').all();
    }
    // ─── Node operations ───────────────────────────────────────────────────
    insertNode(node) {
        this.stmts.insertNode.run({
            id: node.id,
            project: node.project,
            label: node.label,
            name: node.name,
            qualified_name: node.qualified_name,
            file_path: node.file_path,
            start_line: node.start_line,
            end_line: node.end_line,
            props: JSON.stringify(node.props),
        });
    }
    insertNodes(nodes) {
        this.transaction(() => {
            for (const node of nodes)
                this.insertNode(node);
        });
    }
    getNode(id) {
        const row = this.stmts.getNode.get(id);
        return row ? rowToNode(row) : null;
    }
    getNodesByLabel(project, label) {
        return this.stmts.getNodesByLabel.all(project, label).map((r) => rowToNode(r));
    }
    getNodesByFile(project, filePath) {
        return this.stmts.getNodesByFile.all(project, filePath).map((r) => rowToNode(r));
    }
    deleteNodesByProject(project) {
        this.stmts.deleteNodesByProject.run(project);
    }
    deleteNodesByFile(project, filePath) {
        this.stmts.deleteNodesByFile.run(project, filePath);
    }
    /** Delete nodes whose file_path contains substring (GC skip rules). Returns deleted count. */
    deleteNodesByFilePathSubstring(project, substring) {
        const result = this.db
            .prepare("DELETE FROM nodes WHERE project = ? AND file_path LIKE ? ESCAPE '\\'")
            .run(project, `%${substring.replace(/[%_\\]/g, '\\$&')}%`);
        return result.changes;
    }
    updateNodeProps(id, props) {
        this.stmts.updateNodeProps.run({ id, props: JSON.stringify(props) });
    }
    // ─── Edge operations ───────────────────────────────────────────────────
    insertEdge(edge) {
        this.stmts.insertEdge.run({
            project: edge.project,
            source_id: edge.source_id,
            target_id: edge.target_id,
            type: edge.type,
            props: JSON.stringify(edge.props),
            confidence: edge.confidence ?? 1.0,
        });
    }
    insertEdges(edges) {
        this.transaction(() => {
            for (const edge of edges)
                this.insertEdge(edge);
        });
    }
    getOutboundEdges(nodeId, type) {
        const rows = type
            ? this.stmts.getEdgesBySourceAndType.all(nodeId, type)
            : this.stmts.getEdgesBySource.all(nodeId);
        return rows.map((r) => rowToEdge(r));
    }
    getInboundEdges(nodeId, type) {
        const rows = type
            ? this.stmts.getEdgesByTargetAndType.all(nodeId, type)
            : this.stmts.getEdgesByTarget.all(nodeId);
        return rows.map((r) => rowToEdge(r));
    }
    deleteEdgesByProject(project) {
        this.stmts.deleteEdgesByProject.run(project);
    }
    /**
     * Delete all outbound edges of a given type from a source node, project-scoped. (D5)
     *
     * Used by the ts-morph enrichment pass to supersede a wrong-target edge:
     * when compiler resolution resolves a call to a *different* target than
     * tree-sitter did, the (source, target, type) triplet differs so
     * INSERT OR REPLACE won't remove the old edge. This method removes the
     * stale outbound edges before the correct-target edge is inserted.
     *
     * Scoped to `project` so external-package edges on other projects that
     * happen to share source_id and type are never touched.
     */
    deleteOutboundEdgesOfType(project, sourceId, type) {
        deleteOutboundEdgesOfTypeHelper(this.db, project, sourceId, type);
    }
    // ─── Search ────────────────────────────────────────────────────────────
    searchNodes(filter) {
        return runSearchNodes(this.db, filter, (r) => rowToNode(r));
    }
    searchNodesFts(query, limit = 100) {
        return this.stmts.searchNodesFts.all(query, limit).map((r) => rowToNode(r));
    }
    searchNodesRanked(project, query, limit = 100) {
        return runSearchNodesRanked(this.db, project, query, limit);
    }
    // ─── File hash tracking ─────────────────────────────────────────────────
    upsertFileHash(record) {
        this.stmts.upsertFileHash.run(record);
    }
    getFileHash(project, relPath) {
        const row = this.stmts.getFileHash.get(project, relPath);
        return row ? rowToFileHash(row) : null;
    }
    getAllFileHashes(project) {
        return this.stmts.getAllFileHashes.all(project).map(rowToFileHash);
    }
    deleteFileHashes(project) {
        this.stmts.deleteFileHashes.run(project);
    }
    deleteFileHash(project, relPath) {
        this.stmts.deleteFileHash.run(project, relPath);
    }
    // ─── ADR ────────────────────────────────────────────────────────────────
    upsertAdr(record) {
        this.stmts.upsertAdr.run(record);
    }
    getAdr(project) {
        const row = this.stmts.getAdr.get(project);
        return row ? rowToAdr(row) : null;
    }
    deleteAdr(project) {
        this.stmts.deleteAdr.run(project);
    }
    listAdrs() {
        return this.db.prepare('SELECT * FROM project_summaries ORDER BY project').all().map(rowToAdr);
    }
    // ─── Statistics ─────────────────────────────────────────────────────────
    getNodeCount(project) {
        const row = this.stmts.countNodes.get(project);
        return row.count;
    }
    getEdgeCount(project) {
        const row = this.stmts.countEdges.get(project);
        return row.count;
    }
    getNodeLabelCounts(project) {
        return aggregateNodeLabelCounts(this.stmts.getNodeLabelCounts.all(project));
    }
    getEdgeTypeCounts(project) {
        return aggregateEdgeTypeCounts(this.stmts.getEdgeTypeCounts.all(project));
    }
    getRelationshipPatterns(project) {
        const rows = this.stmts.getRelationshipPatterns.all(project);
        return rows.map((r) => r.pattern);
    }
    // ─── Degree queries ─────────────────────────────────────────────────────
    getNodeDegree(nodeId, type, direction = 'both') {
        return runNodeDegreeQuery(this.db, nodeId, type, direction);
    }
    getNodesByDegree(project, options) {
        return runGetNodesByDegree(this.db, project, options, (r) => rowToNode(r));
    }
    // ─── Graph traversal (BFS via recursive CTE) ───────────────────────────
    bfsTraversal(options) {
        return runBfsTraversal(this.db, { ...options, maxNodes: options.maxNodes ?? 200 });
    }
    // ─── Raw query (read-only) ──────────────────────────────────────────────
    rawQuery(sql, params = []) {
        return this.db.prepare(sql).all(...params);
    }
    // ─── Bulk operations (transactional) ────────────────────────────────────
    transaction(fn) {
        const txn = this.db.transaction(fn);
        return txn();
    }
    // ─── Graph metadata ──────────────────────────────────────────────────────
    setGraphMetadata(key, value) {
        this.db
            .prepare('INSERT OR REPLACE INTO graph_metadata (key, value) VALUES (?, ?)')
            .run(key, value);
    }
    getGraphMetadata(key) {
        const row = this.db.prepare('SELECT value FROM graph_metadata WHERE key = ?').get(key);
        return row ? row.value : null;
    }
    // ─── GC / catalog hash ──────────────────────────────────────────────────────
    pruneProject(projectName) {
        return pruneProject(this.db, projectName);
    }
    writeCatalogHash(projectName) {
        writeCatalogHash(this.db, projectName);
    }
    invalidateCatalogHash(projectName) {
        invalidateCatalogHash(this.db, projectName);
    }
    verifyCatalogHash(projectName) {
        return verifyCatalogHash(this.db, projectName);
    }
    detectChangesForSession(projectName, sessionFiles) {
        return detectChangesForSession(this, projectName, sessionFiles);
    }
    // ─── Lifecycle ──────────────────────────────────────────────────────────
    close() {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
        this.db.close();
    }
}
//# sourceMappingURL=graphDatabase.js.map
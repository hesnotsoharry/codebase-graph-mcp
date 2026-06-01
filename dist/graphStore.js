/**
 * graphStore.ts — SQLite-backed graph store using better-sqlite3.
 *
 * Replaces the previous in-memory Map + JSON persistence. All operations
 * are synchronous (better-sqlite3's design). The async save()/load()
 * methods are preserved for API compat but are effectively no-ops — data
 * is persisted on every write via WAL.
 */
import fs from 'fs';
import path from 'path';
import DatabaseCtor from 'better-sqlite3';
function openDatabase(dbPath) {
    const dir = path.dirname(dbPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(dir)) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        fs.mkdirSync(dir, { recursive: true });
    }
    const db = new DatabaseCtor(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    return db;
}
function closeDatabase(db) {
    try {
        db?.close();
    }
    catch {
        // Already closed or invalid.
    }
}
function getSchemaVersion(db) {
    const row = db.prepare('PRAGMA user_version').get();
    return row.user_version;
}
function setSchemaVersion(db, version) {
    db.pragma(`user_version = ${Math.trunc(version)}`);
}
// ── Schema DDL ───────────────────────────────────────────────────────
const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    filePath TEXT NOT NULL,
    line INTEGER NOT NULL,
    endLine INTEGER,
    metadata TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_nodes_type
    ON nodes(type);
  CREATE INDEX IF NOT EXISTS idx_nodes_filePath
    ON nodes(filePath);

  CREATE TABLE IF NOT EXISTS edges (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    type TEXT NOT NULL,
    metadata TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_edges_source
    ON edges(source);
  CREATE INDEX IF NOT EXISTS idx_edges_target
    ON edges(target);
`;
// ── Prepared statement builders ──────────────────────────────────────
function prepareNodeStmts(db) {
    return {
        insertNode: db.prepare(`
      INSERT OR REPLACE INTO nodes
        (id, type, name, filePath, line, endLine, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
        deleteNode: db.prepare('DELETE FROM nodes WHERE id = ?'),
        getNode: db.prepare('SELECT * FROM nodes WHERE id = ?'),
        getAllNodes: db.prepare('SELECT * FROM nodes'),
        getNodesByType: db.prepare('SELECT * FROM nodes WHERE type = ?'),
        getNodesByFile: db.prepare('SELECT * FROM nodes WHERE filePath = ?'),
        deleteNodesForFile: db.prepare('DELETE FROM nodes WHERE filePath = ?'),
        nodeCount: db.prepare('SELECT count(*) AS cnt FROM nodes'),
        fileCount: db.prepare('SELECT count(DISTINCT filePath) AS cnt FROM nodes'),
    };
}
function prepareEdgeStmts(db) {
    return {
        insertEdge: db.prepare('INSERT INTO edges (source, target, type, metadata) VALUES (?, ?, ?, ?)'),
        deleteEdgesForNode: db.prepare('DELETE FROM edges WHERE source = ? OR target = ?'),
        deleteEdgesForFile: db.prepare(`
      DELETE FROM edges
       WHERE source IN (SELECT id FROM nodes WHERE filePath = ?)
          OR target IN (SELECT id FROM nodes WHERE filePath = ?)
    `),
        getEdgesFrom: db.prepare('SELECT * FROM edges WHERE source = ?'),
        getEdgesTo: db.prepare('SELECT * FROM edges WHERE target = ?'),
        getAllEdges: db.prepare('SELECT * FROM edges'),
        edgeCount: db.prepare('SELECT count(*) AS cnt FROM edges'),
    };
}
// ── Row ↔ Object mappers ─────────────────────────────────────────────
function rowToNode(row) {
    const node = {
        id: row.id,
        type: row.type,
        name: row.name,
        filePath: row.filePath,
        line: row.line,
    };
    if (row.endLine != null)
        node.endLine = row.endLine;
    if (row.metadata) {
        node.metadata = JSON.parse(row.metadata);
    }
    return node;
}
function rowToEdge(row) {
    const edge = {
        source: row.source,
        target: row.target,
        type: row.type,
    };
    if (row.metadata) {
        edge.metadata = JSON.parse(row.metadata);
    }
    return edge;
}
// ── GraphStore (SQLite) ──────────────────────────────────────────────
export class GraphStore {
    db;
    stmts;
    txAddBulk;
    txClearFile;
    txReplaceEdges;
    txRemoveNode;
    constructor(projectRoot) {
        // TODO: remove — dead path in standalone; GraphStore is not reachable from the
        // standalone MCP entry point (index.ts uses GraphDatabase via serverBootstrap.ts).
        const dbPath = path.join(projectRoot, '.codebase-graph', 'graph.db');
        this.db = openDatabase(dbPath);
        this.ensureSchema();
        this.stmts = {
            ...prepareNodeStmts(this.db),
            ...prepareEdgeStmts(this.db),
        };
        // Pre-build transactions used in hot paths
        this.txAddBulk = this.db.transaction((nodes, edges) => {
            for (const n of nodes)
                this.insertNode(n);
            for (const e of edges)
                this.insertEdge(e);
        });
        this.txClearFile = this.db.transaction((filePath) => {
            this.stmts.deleteEdgesForFile.run(filePath, filePath);
            this.stmts.deleteNodesForFile.run(filePath);
        });
        this.txReplaceEdges = this.db.transaction((edges) => {
            this.db.exec('DELETE FROM edges');
            for (const e of edges)
                this.insertEdge(e);
        });
        this.txRemoveNode = this.db.transaction((id) => {
            this.stmts.deleteEdgesForNode.run(id, id);
            this.stmts.deleteNode.run(id);
        });
    }
    ensureSchema() {
        if (getSchemaVersion(this.db) < 1) {
            this.db.exec(SCHEMA_V1);
            setSchemaVersion(this.db, 1);
        }
    }
    // ── Internal helpers ──
    insertNode(node) {
        this.stmts.insertNode.run(node.id, node.type, node.name, node.filePath, node.line, node.endLine ?? null, node.metadata ? JSON.stringify(node.metadata) : null);
    }
    insertEdge(edge) {
        this.stmts.insertEdge.run(edge.source, edge.target, edge.type, edge.metadata ? JSON.stringify(edge.metadata) : null);
    }
    // ── Node CRUD ──
    addNode(node) {
        this.insertNode(node);
    }
    removeNode(id) {
        this.txRemoveNode(id);
    }
    getNode(id) {
        const row = this.stmts.getNode.get(id);
        return row ? rowToNode(row) : undefined;
    }
    getAllNodes() {
        return this.stmts.getAllNodes.all().map(rowToNode);
    }
    getNodesByType(type) {
        return this.stmts.getNodesByType.all(type).map(rowToNode);
    }
    getNodesByFile(filePath) {
        return this.stmts.getNodesByFile.all(filePath).map(rowToNode);
    }
    // ── Edge CRUD ──
    addEdge(edge) {
        this.insertEdge(edge);
    }
    removeEdgesForNode(nodeId) {
        this.stmts.deleteEdgesForNode.run(nodeId, nodeId);
    }
    removeEdgesForFile(filePath) {
        this.stmts.deleteEdgesForFile.run(filePath, filePath);
    }
    getEdgesFrom(nodeId) {
        return this.stmts.getEdgesFrom.all(nodeId).map(rowToEdge);
    }
    getEdgesTo(nodeId) {
        return this.stmts.getEdgesTo.all(nodeId).map(rowToEdge);
    }
    getAllEdges() {
        return this.stmts.getAllEdges.all().map(rowToEdge);
    }
    replaceAllEdges(edges) {
        this.txReplaceEdges(edges);
    }
    // ── Bulk operations ──
    addBulk(nodes, edges) {
        this.txAddBulk(nodes, edges);
    }
    clearFile(filePath) {
        this.txClearFile(filePath);
    }
    clear() {
        this.db.exec('DELETE FROM edges; DELETE FROM nodes;');
    }
    // ── Persistence (no-ops — WAL auto-persists) ──
    async save() {
        // No-op: SQLite with WAL persists automatically.
    }
    async load() {
        return this.nodeCount() > 0;
    }
    // ── Stats ──
    nodeCount() {
        return this.stmts.nodeCount.get().cnt;
    }
    edgeCount() {
        return this.stmts.edgeCount.get().cnt;
    }
    fileCount() {
        return this.stmts.fileCount.get().cnt;
    }
    // ── Lifecycle ──
    close() {
        closeDatabase(this.db);
    }
    /** Wrap `fn` in a SQLite transaction. */
    transaction(fn) {
        const tx = this.db.transaction(fn);
        return tx();
    }
}
//# sourceMappingURL=graphStore.js.map
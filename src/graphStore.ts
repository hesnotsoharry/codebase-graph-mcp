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
import type { Database as DatabaseType } from 'better-sqlite3';
import type { IGraphStore } from './graphStoreTypes';
import type { GraphEdge, GraphNode } from './graphTypes';

export type { IGraphStore } from './graphStoreTypes';

// ── Inline database helpers (replaces ../storage/database import) ────────────

type Database = DatabaseType;

function openDatabase(dbPath: string): Database {
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

function closeDatabase(db: Database | null | undefined): void {
  try {
    db?.close();
  } catch {
    // Already closed or invalid.
  }
}

function getSchemaVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

function setSchemaVersion(db: Database, version: number): void {
  db.pragma(`user_version = ${Math.trunc(version)}`);
}

// ── Row types ────────────────────────────────────────────────────────

interface NodeRow {
  id: string;
  type: string;
  name: string;
  filePath: string;
  line: number;
  endLine: number | null;
  metadata: string | null;
}

interface EdgeRow {
  source: string;
  target: string;
  type: string;
  metadata: string | null;
}

interface CountRow {
  cnt: number;
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

function prepareNodeStmts(db: Database) {
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

function prepareEdgeStmts(db: Database) {
  return {
    insertEdge: db.prepare(
      'INSERT INTO edges (source, target, type, metadata) VALUES (?, ?, ?, ?)',
    ),
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

type NodeStmts = ReturnType<typeof prepareNodeStmts>;
type EdgeStmts = ReturnType<typeof prepareEdgeStmts>;
type Stmts = NodeStmts & EdgeStmts;

// ── Row ↔ Object mappers ─────────────────────────────────────────────

function rowToNode(row: NodeRow): GraphNode {
  const node: GraphNode = {
    id: row.id,
    type: row.type as GraphNode['type'],
    name: row.name,
    filePath: row.filePath,
    line: row.line,
  };
  if (row.endLine != null) node.endLine = row.endLine;
  if (row.metadata) {
    node.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  }
  return node;
}

function rowToEdge(row: EdgeRow): GraphEdge {
  const edge: GraphEdge = {
    source: row.source,
    target: row.target,
    type: row.type as GraphEdge['type'],
  };
  if (row.metadata) {
    edge.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  }
  return edge;
}

// ── GraphStore (SQLite) ──────────────────────────────────────────────

export class GraphStore implements IGraphStore {
  private db: Database;
  private stmts: Stmts;
  private txAddBulk: ReturnType<Database['transaction']>;
  private txClearFile: ReturnType<Database['transaction']>;
  private txReplaceEdges: ReturnType<Database['transaction']>;
  private txRemoveNode: ReturnType<Database['transaction']>;

  constructor(projectRoot: string) {
    const dbPath = path.join(projectRoot, '.ouroboros', 'graph.db');
    this.db = openDatabase(dbPath);
    this.ensureSchema();
    this.stmts = {
      ...prepareNodeStmts(this.db),
      ...prepareEdgeStmts(this.db),
    };

    // Pre-build transactions used in hot paths
    this.txAddBulk = this.db.transaction((nodes: GraphNode[], edges: GraphEdge[]) => {
      for (const n of nodes) this.insertNode(n);
      for (const e of edges) this.insertEdge(e);
    });
    this.txClearFile = this.db.transaction((filePath: string) => {
      this.stmts.deleteEdgesForFile.run(filePath, filePath);
      this.stmts.deleteNodesForFile.run(filePath);
    });
    this.txReplaceEdges = this.db.transaction((edges: GraphEdge[]) => {
      this.db.exec('DELETE FROM edges');
      for (const e of edges) this.insertEdge(e);
    });
    this.txRemoveNode = this.db.transaction((id: string) => {
      this.stmts.deleteEdgesForNode.run(id, id);
      this.stmts.deleteNode.run(id);
    });
  }

  private ensureSchema(): void {
    if (getSchemaVersion(this.db) < 1) {
      this.db.exec(SCHEMA_V1);
      setSchemaVersion(this.db, 1);
    }
  }

  // ── Internal helpers ──

  private insertNode(node: GraphNode): void {
    this.stmts.insertNode.run(
      node.id,
      node.type,
      node.name,
      node.filePath,
      node.line,
      node.endLine ?? null,
      node.metadata ? JSON.stringify(node.metadata) : null,
    );
  }

  private insertEdge(edge: GraphEdge): void {
    this.stmts.insertEdge.run(
      edge.source,
      edge.target,
      edge.type,
      edge.metadata ? JSON.stringify(edge.metadata) : null,
    );
  }

  // ── Node CRUD ──

  addNode(node: GraphNode): void {
    this.insertNode(node);
  }

  removeNode(id: string): void {
    this.txRemoveNode(id);
  }

  getNode(id: string): GraphNode | undefined {
    const row = this.stmts.getNode.get(id) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  getAllNodes(): GraphNode[] {
    return (this.stmts.getAllNodes.all() as NodeRow[]).map(rowToNode);
  }

  getNodesByType(type: GraphNode['type']): GraphNode[] {
    return (this.stmts.getNodesByType.all(type) as NodeRow[]).map(rowToNode);
  }

  getNodesByFile(filePath: string): GraphNode[] {
    return (this.stmts.getNodesByFile.all(filePath) as NodeRow[]).map(rowToNode);
  }

  // ── Edge CRUD ──

  addEdge(edge: GraphEdge): void {
    this.insertEdge(edge);
  }

  removeEdgesForNode(nodeId: string): void {
    this.stmts.deleteEdgesForNode.run(nodeId, nodeId);
  }

  removeEdgesForFile(filePath: string): void {
    this.stmts.deleteEdgesForFile.run(filePath, filePath);
  }

  getEdgesFrom(nodeId: string): GraphEdge[] {
    return (this.stmts.getEdgesFrom.all(nodeId) as EdgeRow[]).map(rowToEdge);
  }

  getEdgesTo(nodeId: string): GraphEdge[] {
    return (this.stmts.getEdgesTo.all(nodeId) as EdgeRow[]).map(rowToEdge);
  }

  getAllEdges(): GraphEdge[] {
    return (this.stmts.getAllEdges.all() as EdgeRow[]).map(rowToEdge);
  }

  replaceAllEdges(edges: GraphEdge[]): void {
    this.txReplaceEdges(edges);
  }

  // ── Bulk operations ──

  addBulk(nodes: GraphNode[], edges: GraphEdge[]): void {
    this.txAddBulk(nodes, edges);
  }

  clearFile(filePath: string): void {
    this.txClearFile(filePath);
  }

  clear(): void {
    this.db.exec('DELETE FROM edges; DELETE FROM nodes;');
  }

  // ── Persistence (no-ops — WAL auto-persists) ──

  async save(): Promise<void> {
    // No-op: SQLite with WAL persists automatically.
  }

  async load(): Promise<boolean> {
    return this.nodeCount() > 0;
  }

  // ── Stats ──

  nodeCount(): number {
    return (this.stmts.nodeCount.get() as CountRow).cnt;
  }

  edgeCount(): number {
    return (this.stmts.edgeCount.get() as CountRow).cnt;
  }

  fileCount(): number {
    return (this.stmts.fileCount.get() as CountRow).cnt;
  }

  // ── Lifecycle ──

  close(): void {
    closeDatabase(this.db);
  }

  /** Wrap `fn` in a SQLite transaction. */
  transaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }
}

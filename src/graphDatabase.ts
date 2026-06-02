/**
 * graphDatabase.ts — SQLite property graph store backed by better-sqlite3.
 *
 * Manages the lifecycle of the database, schema creation, and CRUD operations
 * for nodes and edges. All operations are synchronous (better-sqlite3's design).
 */

import Database from 'better-sqlite3';

import type { ChangedSymbolsForSession } from './detectChangesForSessionTypes';
import {
  aggregateEdgeTypeCounts,
  aggregateNodeLabelCounts,
  type BfsOptions,
  buildCoreStatements,
  buildHashAndProjectStatements,
  buildSearchAndStatsStatements,
  deleteOutboundEdgesOfType as deleteOutboundEdgesOfTypeHelper,
  type NodesByDegreeOptions,
  rowToAdr,
  rowToEdge,
  rowToFileHash,
  rowToNode,
  rowToProject,
  runBfsTraversal,
  runGetNodesByDegree,
  runNodeDegreeQuery,
  runSearchNodes,
  runSearchNodesRanked,
  SCHEMA_SQL,
} from './graphDatabaseHelpers';

import os from 'os';
import path from 'path';

/** Default DB path for the standalone package (no Electron dependency). */
function defaultDbPath(): string {
  return path.join(os.homedir(), '.codebase-graph', 'graph.db');
}
import { migrateToV1, migrateToV2 } from './graphDatabaseMigrations';
import { SCHEMA_VERSION } from './graphDatabaseSchema';
import {
  detectChangesForSession,
  invalidateCatalogHash,
  pruneProject,
  verifyCatalogHash,
  writeCatalogHash,
} from './graphDatabaseSession';
import type {
  ADRRecord,
  EdgeType,
  FileHashRecord,
  GraphEdge,
  GraphNode,
  NodeFilter,
  NodeLabel,
  NodeSearchResult,
  ProjectRecord,
} from './graphDatabaseTypes';

// ─── GraphDatabase class ─────────────────────────────────────────────────────

export class GraphDatabase {
  private db: Database.Database;
  private stmts!: Record<string, Database.Statement>;

  constructor(dbPath?: string, opts: { readonly?: boolean } = {}) {
    const p = dbPath ?? defaultDbPath();
    const ro = opts.readonly === true;
    this.db = ro ? new Database(p, { readonly: true, fileMustExist: true }) : new Database(p);
    this.applyPragmas(ro);
    if (!ro) this.createSchema();
    this.prepareStatements();
  }

  private applyPragmas(ro: boolean): void {
    if (!ro) this.db.pragma('journal_mode = WAL');
    if (!ro) this.db.pragma('synchronous = NORMAL');
    const pragmas = ['cache_size = -32000', 'temp_store = MEMORY', 'mmap_size = 134217728', 'foreign_keys = ON', 'busy_timeout = 5000'];
    for (const p of pragmas) this.db.pragma(p);
  }

  private createSchema(): void {
    this.db.exec(SCHEMA_SQL);
    this.runMigrations();
  }

  private runMigrations(): void {
    const current = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    if (current >= SCHEMA_VERSION) return;
    const txn = this.db.transaction(() => {
      if (current < 1) migrateToV1(this.db);
      if (current < 2) migrateToV2(this.db);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    txn();
  }

  private prepareStatements(): void {
    this.stmts = {
      ...buildCoreStatements(this.db),
      ...buildHashAndProjectStatements(this.db),
      ...buildSearchAndStatsStatements(this.db),
    };
  }

  // ─── Project operations ─────────────────────────────────────────────────

  upsertProject(project: ProjectRecord): void {
    this.stmts.upsertProject.run(project);
  }

  getProject(name: string): ProjectRecord | null {
    const row = this.stmts.getProject.get(name);
    return row ? rowToProject(row as Record<string, unknown>) : null;
  }

  listProjects(): ProjectRecord[] {
    return (this.stmts.listProjects.all() as Record<string, unknown>[]).map(rowToProject);
  }

  deleteProject(name: string): void {
    this.stmts.deleteProject.run(name);
  }

  touchProjectOpened(name: string): void {
    this.db.prepare('UPDATE projects SET last_opened_at = ? WHERE name = ?').run(Date.now(), name);
  }

  getProjectLastOpened(name: string): number | null {
    const row = this.db.prepare('SELECT last_opened_at FROM projects WHERE name = ?').get(name) as { last_opened_at: number } | undefined;
    return row ? row.last_opened_at : null;
  }

  listAllProjects(): { name: string; last_opened_at: number }[] {
    type Row = { name: string; last_opened_at: number };
    return this.db.prepare('SELECT name, last_opened_at FROM projects ORDER BY name').all() as Row[];
  }

  // ─── Node operations ───────────────────────────────────────────────────

  insertNode(node: GraphNode): void {
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

  insertNodes(nodes: GraphNode[]): void {
    this.transaction(() => {
      for (const node of nodes) this.insertNode(node);
    });
  }

  getNode(id: string): GraphNode | null {
    const row = this.stmts.getNode.get(id);
    return row ? rowToNode(row) : null;
  }

  getNodesByLabel(project: string, label: NodeLabel): GraphNode[] {
    return this.stmts.getNodesByLabel.all(project, label).map((r) => rowToNode(r));
  }

  getNodesByFile(project: string, filePath: string): GraphNode[] {
    return this.stmts.getNodesByFile.all(project, filePath).map((r) => rowToNode(r));
  }

  deleteNodesByProject(project: string): void {
    this.stmts.deleteNodesByProject.run(project);
  }
  deleteNodesByFile(project: string, filePath: string): void {
    this.stmts.deleteNodesByFile.run(project, filePath);
  }

  /** Delete nodes whose file_path contains substring (GC skip rules). Returns deleted count. */
  deleteNodesByFilePathSubstring(project: string, substring: string): number {
    const result = this.db
      .prepare("DELETE FROM nodes WHERE project = ? AND file_path LIKE ? ESCAPE '\\'")
      .run(project, `%${substring.replace(/[%_\\]/g, '\\$&')}%`);
    return result.changes;
  }

  updateNodeProps(id: string, props: Record<string, unknown>): void {
    this.stmts.updateNodeProps.run({ id, props: JSON.stringify(props) });
  }

  // ─── Edge operations ───────────────────────────────────────────────────

  insertEdge(edge: Omit<GraphEdge, 'id'>): void {
    this.stmts.insertEdge.run({
      project: edge.project,
      source_id: edge.source_id,
      target_id: edge.target_id,
      type: edge.type,
      props: JSON.stringify(edge.props),
      confidence: edge.confidence ?? 1.0,
    });
  }

  insertEdges(edges: Omit<GraphEdge, 'id'>[]): void {
    this.transaction(() => {
      for (const edge of edges) this.insertEdge(edge);
    });
  }

  getOutboundEdges(nodeId: string, type?: EdgeType): GraphEdge[] {
    const rows = type
      ? this.stmts.getEdgesBySourceAndType.all(nodeId, type)
      : this.stmts.getEdgesBySource.all(nodeId);
    return rows.map((r) => rowToEdge(r));
  }

  getInboundEdges(nodeId: string, type?: EdgeType): GraphEdge[] {
    const rows = type
      ? this.stmts.getEdgesByTargetAndType.all(nodeId, type)
      : this.stmts.getEdgesByTarget.all(nodeId);
    return rows.map((r) => rowToEdge(r));
  }

  deleteEdgesByProject(project: string): void {
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
  deleteOutboundEdgesOfType(project: string, sourceId: string, type: EdgeType): void {
    deleteOutboundEdgesOfTypeHelper(this.db, project, sourceId, type);
  }

  // ─── Search ────────────────────────────────────────────────────────────

  searchNodes(filter: NodeFilter): NodeSearchResult {
    return runSearchNodes(this.db, filter, (r) => rowToNode(r));
  }

  searchNodesFts(query: string, limit: number = 100): GraphNode[] {
    return this.stmts.searchNodesFts.all(query, limit).map((r) => rowToNode(r));
  }

  searchNodesRanked(
    project: string,
    query: string,
    limit: number = 100,
  ): Array<GraphNode & { rank: number }> {
    return runSearchNodesRanked(this.db, project, query, limit);
  }

  // ─── File hash tracking ─────────────────────────────────────────────────

  upsertFileHash(record: FileHashRecord): void {
    this.stmts.upsertFileHash.run(record);
  }

  getFileHash(project: string, relPath: string): FileHashRecord | null {
    const row = this.stmts.getFileHash.get(project, relPath);
    return row ? rowToFileHash(row as Record<string, unknown>) : null;
  }

  getAllFileHashes(project: string): FileHashRecord[] {
    return (this.stmts.getAllFileHashes.all(project) as Record<string, unknown>[]).map(rowToFileHash);
  }

  deleteFileHashes(project: string): void {
    this.stmts.deleteFileHashes.run(project);
  }
  deleteFileHash(project: string, relPath: string): void {
    this.stmts.deleteFileHash.run(project, relPath);
  }

  // ─── ADR ────────────────────────────────────────────────────────────────

  upsertAdr(record: ADRRecord): void {
    this.stmts.upsertAdr.run(record);
  }

  getAdr(project: string): ADRRecord | null {
    const row = this.stmts.getAdr.get(project);
    return row ? rowToAdr(row as Record<string, unknown>) : null;
  }

  deleteAdr(project: string): void {
    this.stmts.deleteAdr.run(project);
  }

  listAdrs(): ADRRecord[] {
    return (
      this.db.prepare('SELECT * FROM project_summaries ORDER BY project').all() as Record<
        string,
        unknown
      >[]
    ).map(rowToAdr);
  }

  // ─── Statistics ─────────────────────────────────────────────────────────

  getNodeCount(project: string): number {
    const row = this.stmts.countNodes.get(project) as { count: number };
    return row.count;
  }

  getEdgeCount(project: string): number {
    const row = this.stmts.countEdges.get(project) as { count: number };
    return row.count;
  }

  getNodeLabelCounts(project: string): Record<NodeLabel, number> {
    return aggregateNodeLabelCounts(
      this.stmts.getNodeLabelCounts.all(project) as Array<{ label: string; count: number }>,
    );
  }

  getEdgeTypeCounts(project: string): Record<EdgeType, number> {
    return aggregateEdgeTypeCounts(
      this.stmts.getEdgeTypeCounts.all(project) as Array<{ type: string; count: number }>,
    );
  }

  getRelationshipPatterns(project: string): string[] {
    const rows = this.stmts.getRelationshipPatterns.all(project) as Array<{ pattern: string }>;
    return rows.map((r) => r.pattern);
  }

  // ─── Degree queries ─────────────────────────────────────────────────────

  getNodeDegree(
    nodeId: string,
    type?: EdgeType,
    direction: 'in' | 'out' | 'both' = 'both',
  ): number {
    return runNodeDegreeQuery(this.db, nodeId, type, direction);
  }

  getNodesByDegree(project: string, options: NodesByDegreeOptions): NodeSearchResult {
    return runGetNodesByDegree(this.db, project, options, (r) => rowToNode(r));
  }

  // ─── Graph traversal (BFS via recursive CTE) ───────────────────────────

  bfsTraversal(
    options: BfsOptions & { maxNodes?: number },
  ): Array<{ id: string; depth: number; path: string[] }> {
    return runBfsTraversal(this.db, { ...options, maxNodes: options.maxNodes ?? 200 });
  }

  // ─── Raw query (read-only) ──────────────────────────────────────────────

  rawQuery(sql: string, params: unknown[] = []): unknown[] {
    return this.db.prepare(sql).all(...params);
  }

  // ─── Bulk operations (transactional) ────────────────────────────────────

  transaction<T>(fn: () => T): T {
    const txn = this.db.transaction(fn);
    return txn();
  }

  // ─── Graph metadata ──────────────────────────────────────────────────────

  setGraphMetadata(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO graph_metadata (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  getGraphMetadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM graph_metadata WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  // ─── GC / catalog hash ──────────────────────────────────────────────────────

  pruneProject(projectName: string): { nodes: number; edges: number } {
    return pruneProject(this.db, projectName);
  }

  writeCatalogHash(projectName: string): void {
    writeCatalogHash(this.db, projectName);
  }

  invalidateCatalogHash(projectName: string): void {
    invalidateCatalogHash(this.db, projectName);
  }

  verifyCatalogHash(projectName: string): boolean {
    return verifyCatalogHash(this.db, projectName);
  }

  detectChangesForSession(projectName: string, sessionFiles: string[]): ChangedSymbolsForSession {
    return detectChangesForSession(this, projectName, sessionFiles);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  close(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}

/**
 * graphControllerCompat.ts — Drop-in compatibility shim that exposes System 1's
 * GraphController interface while delegating all operations to System 2 internals.
 *
 * Consumers call getGraphController() / acquireGraphController() from
 * graphControllerCompatRegistry.ts and receive a GraphControllerCompat instance.
 * Every public method matches the System 1 GraphController surface exactly.
 */

import path from 'path';

import { consoleErrorLogger as log } from './loggerInterface';
import type { AutoSyncWatcher } from './autoSync';
import type { CypherEngine } from './cypherEngine';
import {
  compatDetectChanges,
  compatDetectChangesForSession,
  compatGetArchitecture,
  compatGetCodeSnippet,
  compatGetGraphSchema,
  compatGetIndexStatus,
  compatQueryGraph,
  compatSearchCode,
  compatSearchGraph,
  compatTraceCallPath,
} from './graphControllerCompatQueries';
import type { GraphDatabase } from './graphDatabase';
import type {
  ArchitectureView,
  CallPathResult,
  ChangeDetectionResult,
  CodeSnippetResult,
  GraphSchema,
  GraphToolContext,
  IndexStatus,
  SearchResult,
} from './graphTypes';
import type { IndexingWorkerClient } from './indexingWorkerClient';
import type { QueryEngine } from './queryEngine';

// ─── Handle type (subset of what registry tracks) ─────────────────────────────

export interface CompatHandle {
  db: GraphDatabase;
  queryEngine: QueryEngine;
  cypherEngine: CypherEngine;
  workerClient: IndexingWorkerClient;
  watcher: AutoSyncWatcher | null;
  projectRoot: string;
  projectName: string;
}

// ─── GraphControllerCompat ────────────────────────────────────────────────────

export class GraphControllerCompat {
  readonly rootPath: string;
  private handle: CompatHandle;
  private _initialized = false;

  constructor(handle: CompatHandle) {
    this.handle = handle;
    this.rootPath = handle.projectRoot;
    this._initialized = handle.db.getProject(handle.projectName) !== null;
  }

  // ─── Status & context ──────────────────────────────────────────────────

  getStatus(): IndexStatus {
    return compatGetIndexStatus(
      this.handle.db,
      this.handle.projectName,
      this.handle.projectRoot,
      this._initialized,
    );
  }

  indexStatus = this.getStatus.bind(this);

  getGraphToolContext(): GraphToolContext {
    const { db, queryEngine, cypherEngine, workerClient, projectRoot, projectName } = this.handle;
    return {
      db,
      queryEngine,
      cypherEngine,
      pipeline: {
        index: (options) => workerClient.runIndex({ ...options, onProgress: () => {} }),
      },
      projectRoot,
      projectName,
    };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  onFileChange(paths: string[] = []): void {
    this.handle.watcher?.onFileChange(paths);
  }

  onSessionStart(): void {
    this._initialized = true;
    this.handle.watcher?.onSessionStart();
  }

  onGitCommit(): void {
    this.handle.watcher?.onGitCommit();
  }

  async dispose(): Promise<void> {
    this._initialized = false;
    log.info(`[compat] dispose ${this.handle.projectName}`);
  }

  // ─── Indexing ────────────────────────────────────────────────────────────

  async indexRepository(opts: {
    projectRoot: string;
    projectName: string;
    incremental: boolean;
  }): Promise<{ success: boolean }> {
    try {
      const result = await this.handle.workerClient.runIndex({
        projectRoot: opts.projectRoot,
        projectName: opts.projectName,
        incremental: opts.incremental,
      });
      if (result.success) this._initialized = true;
      return { success: result.success };
    } catch (err) {
      log.error('[compat] indexRepository error:', err);
      return { success: false };
    }
  }

  listProjects(): string[] {
    return this._initialized ? [this.rootPath] : [];
  }

  deleteProject(projectRoot: string): { success: boolean } {
    if (projectRoot !== this.rootPath) return { success: false };
    this.handle.db.deleteProject(this.handle.projectName);
    this._initialized = false;
    return { success: true };
  }

  // ─── Query methods ───────────────────────────────────────────────────────

  searchGraph(query: string, limit?: number): SearchResult[] {
    return compatSearchGraph(this.handle.db, this.handle.projectName, query, limit);
  }

  queryGraph(query: string): Array<Record<string, unknown>> {
    return compatQueryGraph(this.handle.cypherEngine, query);
  }

  traceCallPath(fromId: string, toId: string, maxDepth?: number): CallPathResult {
    const fromName = extractName(fromId);
    const toName = extractName(toId);
    return compatTraceCallPath(this.handle.queryEngine, fromName, toName, maxDepth);
  }

  getArchitecture(aspects?: string[]): ArchitectureView {
    return compatGetArchitecture(this.handle.queryEngine, aspects);
  }

  async getCodeSnippet(symbolId: string): Promise<CodeSnippetResult | null> {
    return compatGetCodeSnippet(
      this.handle.db,
      this.handle.queryEngine,
      this.handle.projectName,
      symbolId,
    );
  }

  getGraphSchema(): GraphSchema {
    return compatGetGraphSchema(this.handle.queryEngine);
  }

  async detectChanges(): Promise<ChangeDetectionResult> {
    return compatDetectChanges(this.handle.queryEngine);
  }

  async detectChangesForSession(
    sessionId: string,
    files: string[],
  ): Promise<ChangeDetectionResult> {
    return compatDetectChangesForSession(this.handle.db, this.handle.projectName, sessionId, files);
  }

  async searchCode(
    pattern: string,
    opts?: { fileGlob?: string; maxResults?: number },
  ): Promise<Array<{ filePath: string; line: number; match: string }>> {
    return compatSearchCode({
      projectRoot: this.handle.projectRoot,
      db: this.handle.db,
      projectName: this.handle.projectName,
      pattern,
      opts,
    });
  }

  // ─── Pass-through helpers ────────────────────────────────────────────────

  ingestTraces(traces: unknown[]): { success: boolean; ingested: number } {
    if (!Array.isArray(traces)) return { success: false, ingested: 0 };
    const edges = traces.filter(isTraceInput).map((t) => ({
      project: this.handle.projectName,
      source_id: t.fromId,
      target_id: t.toId,
      type: (t.type ?? 'HTTP_CALLS') as import('./graphDatabaseTypes').EdgeType,
      props: {},
    }));
    this.handle.db.insertEdges(edges);
    return { success: true, ingested: edges.length };
  }

  manageAdr(action: 'list' | 'get' | 'create' | 'update' | 'delete', id?: string): unknown {
    const adrDir = path.join(this.rootPath, 'docs', 'adr');
    const messages = new Map<string, string>([
      ['list', 'ADR directory: ' + adrDir],
      ['get', 'ADR not found'],
      ['create', 'ADR creation requires file system write — use files:writeFile'],
      ['update', 'ADR update requires file system write — use files:writeFile'],
      ['delete', 'ADR deletion requires file system operation'],
    ]);
    const msg = messages.get(action);
    return msg
      ? { success: true, ...(id ? { id } : {}), message: msg }
      : { success: false, error: 'Unknown ADR action' };
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Extract the symbol name from either a S1 id (`path::name::type::line`)
 * or treat the whole string as a name (S2 qualified_name or bare name).
 */
function extractName(id: string): string {
  if (id.includes('::')) {
    const parts = id.split('::');
    return parts[1] ?? id;
  }
  // S2 qualified_name: last segment after the last '.'
  const dotIdx = id.lastIndexOf('.');
  return dotIdx >= 0 ? id.slice(dotIdx + 1) : id;
}

interface TraceInput {
  fromId: string;
  toId: string;
  type?: string;
}

function isTraceInput(t: unknown): t is TraceInput {
  return (
    typeof t === 'object' &&
    t !== null &&
    typeof (t as TraceInput).fromId === 'string' &&
    typeof (t as TraceInput).toId === 'string'
  );
}

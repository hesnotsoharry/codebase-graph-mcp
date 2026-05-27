/**
 * graphControllerSupport.ts — Singleton management for the codebase graph
 * engine. Post-Phase-E: System 2 only — all acquire/release paths delegate
 * to graphControllerCompatRegistry.
 */

import { consoleErrorLogger as log } from './loggerInterface';
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

// ---------------------------------------------------------------------------
// GraphControllerLike — stable consumer API.
//
// GraphControllerCompat conforms to this interface structurally.
// The registry stores GraphControllerLike so consumers receive a consistent
// type regardless of the underlying implementation.
// ---------------------------------------------------------------------------

export interface GraphControllerLike {
  readonly rootPath: string;
  getStatus(): IndexStatus;
  indexStatus: () => IndexStatus;
  getGraphToolContext(): GraphToolContext;
  onSessionStart(): void;
  onGitCommit(): void;
  onFileChange(paths: string[]): void;
  indexRepository(opts: {
    projectRoot: string;
    projectName: string;
    incremental: boolean;
  }): Promise<{ success: boolean }>;
  listProjects(): string[];
  deleteProject(projectRoot: string): { success: boolean };
  detectChanges(): Promise<ChangeDetectionResult>;
  detectChangesForSession(sessionId: string, files: string[]): Promise<ChangeDetectionResult>;
  getArchitecture(aspects?: string[]): ArchitectureView;
  getCodeSnippet(symbolId: string): Promise<CodeSnippetResult | null>;
  getGraphSchema(): GraphSchema;
  ingestTraces(traces: unknown[]): { success: boolean; ingested: number };
  manageAdr(action: 'list' | 'get' | 'create' | 'update' | 'delete', id?: string): unknown;
  queryGraph(query: string): Array<Record<string, unknown>>;
  searchCode(
    pattern: string,
    opts?: { fileGlob?: string; maxResults?: number },
  ): Promise<Array<{ filePath: string; line: number; match: string }>>;
  searchGraph(query: string, limit?: number): SearchResult[];
  traceCallPath(fromId: string, toId: string, maxDepth?: number): CallPathResult;
  dispose(): Promise<void>;
}

// ── Per-root registry (keyed by normalized root, ref-counted) ──────────────
//
// Stores GraphControllerLike — both GraphControllerCompat instances and any
// future implementations are accepted without type casts.

interface RegistryEntry {
  controller: GraphControllerLike;
  refCount: number;
}

const registry = new Map<string, RegistryEntry>();
let defaultRoot: string | null = null;

// Shared System 2 GraphDatabase instance — injected at startup by
// initCodebaseGraph via setSystem2Db(). Allows per-window acquire to reuse
// the same DB connection rather than opening a new one per root.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- avoid direct import of GraphDatabase here to prevent eager load
let _system2Db: any | null = null;

/** Called once at startup with the shared GraphDatabase instance. */
export function setSystem2Db(db: unknown): void {
  _system2Db = db;
}

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Register controller as the default-root instance. */
export function setGraphController(controller: GraphControllerLike): void {
  const key = normalizeRoot(controller.rootPath);
  defaultRoot = key;
  registry.set(key, { controller, refCount: 1 });
}

/**
 * Returns the default-root controller, or null if none is registered.
 * Callers without a specific root context use this.
 */
export function getGraphController(): GraphControllerLike | null {
  if (defaultRoot) return registry.get(defaultRoot)?.controller ?? null;
  const first = registry.values().next();
  return first.done ? null : first.value.controller;
}

/** Returns the controller for a specific root, or null if not registered. */
export function getGraphControllerForRoot(root: string): GraphControllerLike | null {
  return registry.get(normalizeRoot(root))?.controller ?? null;
}

/** Resolves the effective root — in the standalone package there is no session
 * store, so this always returns root unchanged. */
async function resolveEffectiveRoot(root: string, _sessionId: string | undefined): Promise<string> {
  return root;
}

/**
 * Acquire a GraphControllerCompat for root. Increments ref-count if already
 * acquired. Always delegates to graphControllerCompatRegistry (System 2).
 *
 * opts.sessionId: when provided the session's worktreePath (if active) is used
 * as the registry key so the graph is indexed against the isolated worktree
 * rather than the main project root.
 */
export async function acquireGraphController(
  root: string,
  opts?: { sessionId?: string },
): Promise<GraphControllerLike> {
  const effectiveRoot = await resolveEffectiveRoot(root, opts?.sessionId);
  const key = normalizeRoot(effectiveRoot);
  const existing = registry.get(key);
  if (existing) {
    existing.refCount++;
    return existing.controller;
  }

  const compatRegistry = await import('./graphControllerCompatRegistry');
  const { IndexingPipeline } = await import('./indexingPipeline');
  const { TreeSitterParser } = await import('./treeSitterParser');
  const parser = new TreeSitterParser();
  await parser.init();
  const { GraphDatabase } = await import('./graphDatabase');
  // Reuse the shared DB injected at startup if available; otherwise open a
  // new connection (e.g. first window opened before startup completes).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- _system2Db stored as any to avoid eager import at module init
  const db: any = (_system2Db as any) ?? new GraphDatabase();
  const pipeline = new IndexingPipeline(db, parser);
  const compat = await compatRegistry.acquireGraphController(effectiveRoot, pipeline);
  registry.set(key, { controller: compat, refCount: 1 });
  if (!defaultRoot) defaultRoot = key;
  return compat;
}

/** Release a ref. Disposes the controller when ref-count reaches zero. */
export async function releaseGraphController(root: string): Promise<void> {
  const key = normalizeRoot(root);
  const entry = registry.get(key);
  if (!entry) return;

  entry.refCount--;
  if (entry.refCount <= 0) {
    await entry.controller.dispose();
    registry.delete(key);
    if (defaultRoot === key) {
      log.info(`[graph-support] released default root: ${root}`);
      defaultRoot = null;
    }
  }
}

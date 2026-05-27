/**
 * serverBootstrap.ts — Context construction and tool registration for the
 * standalone codebase-graph MCP server.
 *
 * Separated from index.ts so each unit stays under the max-lines: 300 cap.
 */
/* eslint-disable max-lines */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { CypherEngine } from './cypherEngine';
import { GraphDatabase } from './graphDatabase';
import type { GraphToolContext } from './graphTypes';
import { IndexingPipeline } from './indexingPipeline';
import { createGraphMcpTools } from './mcpToolHandlers';
import { QueryEngine } from './queryEngine';
import { TreeSitterParser } from './treeSitterParser';

// ── Lazy auto-init constants ──────────────────────────────────────────────────

/**
 * Rate-limit window for the staleness check (ms). After a successful check
 * passes, tool calls within this window skip re-checking the source tree.
 * Mirrors AutoSyncWatcher.adaptivePollInterval floor (autoSync.ts:121).
 */
export const LAZY_INIT_RATE_LIMIT_MS = 60_000;

/**
 * Tools that bypass the lazy-init guard entirely.
 *
 * - `ping`: health-check, needs no graph data
 * - `index_repository`: user is explicitly managing the index; guard would be circular
 * - `index_status`: introspection on the project metadata record, not the graph
 * - `list_projects`: reads project metadata rows — works on an empty or unindexed DB
 * - `delete_project`: administrative action on metadata — does not need a populated graph
 */
export const LAZY_INIT_BYPASS_TOOLS = new Set([
  'ping',
  'index_repository',
  'index_status',
  'list_projects',
  'delete_project',
]);

// ── DB path derivation ────────────────────────────────────────────────────────

/** Derives a stable DB path for `rootPath` under ~/.ouroboros-graph/<hash8>/. */
export function buildDbPath(rootPath: string): string {
  const hash = crypto.createHash('sha256').update(rootPath).digest('hex').slice(0, 8);
  const dir = path.join(os.homedir(), '.ouroboros-graph', hash);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'graph.db');
}

// ── Context construction ──────────────────────────────────────────────────────

/**
 * Wraps an IndexingPipeline so the TreeSitterParser is lazily initialized
 * (via parser.init()) on the first index() call. The parser requires async
 * WASM initialization; we can't await at construction time in a sync factory.
 *
 * @remarks
 * The pipeline is constructed lazily because TreeSitterParser requires
 * `parser.init()` (an async WASM load) before any parsing can happen.
 * `parser.init()` cannot be called synchronously at module-load time —
 * it must be awaited inside the first `index()` call. The lazy wrapper
 * captures this constraint at the boundary so callers can construct
 * the pipeline synchronously and pay the WASM load cost on first use.
 */
function makeLazyPipeline(
  db: GraphDatabase,
  parser: TreeSitterParser,
): GraphToolContext['pipeline'] {
  const innerPipeline = new IndexingPipeline(db, parser);
  let parserReady = false;
  return {
    async index(opts) {
      if (!parserReady) {
        await parser.init();
        parserReady = true;
      }
      return innerPipeline.index(opts);
    },
  };
}

/** Constructs a fully-wired GraphToolContext for the given root and DB path. */
export function buildContext(rootPath: string, dbPath: string): GraphToolContext {
  // Normalize the same way IndexingPipeline does: indexer writes rows tagged
  // with the normalized name; QueryEngine must read with the same shape or
  // every filtered query returns zero rows.
  const projectName = path
    .basename(rootPath)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  const db = new GraphDatabase(dbPath);
  const queryEngine = new QueryEngine(db, projectName, rootPath);
  const cypherEngine = new CypherEngine(db, projectName);
  const parser = new TreeSitterParser();
  const pipeline = makeLazyPipeline(db, parser);
  return { db, queryEngine, cypherEngine, pipeline, projectRoot: rootPath, projectName };
}

// ── Lazy index guard ──────────────────────────────────────────────────────────

/** Maximum number of files walked when computing the source-tree signature. */
const SIGNATURE_FILE_CAP = 2_000;

/**
 * Computes a lightweight source-tree signature for `rootPath`.
 * Walks the directory tree up to SIGNATURE_FILE_CAP files, summing each
 * file's mtime (ms) and accumulating a file count. The signature is a
 * two-element tuple `[fileCount, mtimeSum]` serialised as a string.
 * Intentionally avoids content hashing — mtime+count is cheap (O(N stat
 * calls) without any I/O reads) and sufficient for staleness detection at the
 * lazy-init granularity (seconds, not sub-second precision).
 *
 * Directories named `node_modules`, `.git`, `dist`, `build`, or `out` are
 * skipped to avoid walking irrelevant trees — matches the indexer's skip list.
 */
export function computeSourceSignature(rootPath: string): string {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', 'vendor', 'target']);
  let fileCount = 0;
  let mtimeSum = 0;

  function walk(dir: string): void {
    if (fileCount >= SIGNATURE_FILE_CAP) return;
    let entries: fs.Dirent[];
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- rootPath from trusted buildContext call
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission error or gone — skip
    }
    for (const entry of entries) {
      if (fileCount >= SIGNATURE_FILE_CAP) break;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from trusted rootPath + readdir entry
          const stat = fs.statSync(path.join(dir, entry.name));
          mtimeSum += stat.mtimeMs;
          fileCount++;
        } catch {
          // File vanished between readdir and stat — skip
        }
      }
    }
  }

  walk(rootPath);
  return `${fileCount}:${mtimeSum}`;
}

/**
 * Guards graph-requiring tool calls with a lazy auto-init check.
 *
 * Three states on each check (outside the rate-limit window):
 *   1. Empty DB (0 nodes) → full index (incremental: false)
 *   2. Non-empty DB with unknown or changed source signature → incremental index
 *   3. Non-empty DB with matching source signature → skip
 *
 * After any successful verification, subsequent calls within
 * LAZY_INIT_RATE_LIMIT_MS skip the check entirely.
 *
 * The guard instance is created once per `registerGraphTools` call and shared
 * across all applicable tool registrations, so the rate-limit state is
 * coherent across concurrent tool invocations within a single server session.
 */
export class LazyIndexGuard {
  private lastCheckAt = 0;
  private lastSignature: string | null = null;

  async checkAndIndex(context: GraphToolContext, rootPath: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastCheckAt < LAZY_INIT_RATE_LIMIT_MS) {
      // Within rate-limit window — skip the staleness check
      return;
    }

    const nodeCount = context.db.getNodeCount(context.projectName);

    if (nodeCount === 0) {
      // Empty DB — run full index
      console.error('[trace:graph-mcp.auto-init] empty graph — running full index');
      await context.pipeline.index({
        projectRoot: rootPath,
        incremental: false,
        onProgress: () => {},
      });
      this.lastSignature = computeSourceSignature(rootPath);
      this.lastCheckAt = Date.now();
      return;
    }

    // Non-empty DB — check source-tree staleness
    const currentSignature = computeSourceSignature(rootPath);
    if (this.lastSignature !== null && currentSignature === this.lastSignature) {
      // Signature unchanged — mark fresh
      this.lastCheckAt = Date.now();
      return;
    }

    // Signature changed or unknown (first check of session with existing DB)
    // Run incremental reindex
    console.error('[trace:graph-mcp.auto-init] stale or unverified graph — running incremental index');
    await context.pipeline.index({
      projectRoot: rootPath,
      incremental: true,
      onProgress: () => {},
    });
    this.lastSignature = computeSourceSignature(rootPath);
    this.lastCheckAt = Date.now();
  }
}

// ── Tool registration ─────────────────────────────────────────────────────────

/**
 * Passthrough Zod schema — accepts any object without validation.
 * Used because our tool defs carry raw JSON Schema (not Zod) and the MCP SDK's
 * registerTool API requires Zod. The handlers perform their own arg coercion;
 * validation at the schema layer is not needed for the standalone server.
 */
const anyArgs = z.object({}).passthrough();

/**
 * Registers all 14 graph tools from createGraphMcpTools() plus the existing
 * ping health-check tool on the provided McpServer instance.
 *
 * A shared LazyIndexGuard is created once and wraps every graph-requiring
 * tool call (all tools EXCEPT ping, index_repository, and index_status).
 * The guard blocks until the graph is populated before the tool handler runs.
 */
export function registerGraphTools(
  server: McpServer,
  context: GraphToolContext,
  rootPath: string,
): void {
  const guard = new LazyIndexGuard();
  const tools = createGraphMcpTools(context);
  for (const def of tools) {
    const { name, description, handler } = def;
    server.registerTool(
      name,
      { description, inputSchema: anyArgs },
      async (args: Record<string, unknown>) => {
        console.error(`[trace:graph-mcp.tool.${name}] called`);
        if (!LAZY_INIT_BYPASS_TOOLS.has(name)) {
          await guard.checkAndIndex(context, rootPath);
        }
        return handler(args ?? {}, rootPath) as Promise<CallToolResult>;
      },
    );
  }
}

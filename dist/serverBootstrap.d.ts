/**
 * serverBootstrap.ts — Context construction and tool registration for the
 * standalone codebase-graph MCP server.
 *
 * Separated from index.ts so each unit stays under the max-lines: 300 cap.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { GraphToolContext } from './graphTypes';
/**
 * Rate-limit window for the staleness check (ms). After a successful check
 * passes, tool calls within this window skip re-checking the source tree.
 * Mirrors AutoSyncWatcher.adaptivePollInterval floor (autoSync.ts:121).
 */
export declare const LAZY_INIT_RATE_LIMIT_MS = 60000;
/**
 * Tools that bypass the lazy-init guard entirely.
 *
 * - `ping`: health-check, needs no graph data
 * - `index_repository`: user is explicitly managing the index; guard would be circular
 * - `index_status`: introspection on the project metadata record, not the graph
 * - `list_projects`: reads project metadata rows — works on an empty or unindexed DB
 * - `delete_project`: administrative action on metadata — does not need a populated graph
 */
export declare const LAZY_INIT_BYPASS_TOOLS: Set<string>;
/**
 * Canonicalizes `rootPath` and returns its 8-char storage hash. Pure — no I/O.
 *
 * Folds path-separator style (backslash vs forward-slash), trailing slashes, and
 * drive-letter case so two spellings of the SAME folder map to one DB. Without this,
 * `C:\Web App\X` (from a cwd fallback) and `C:/Web App/X` (from an explicit --root)
 * hash to two directories and index the same project twice.
 */
export declare function rootHash(rootPath: string): string;
/** Derives a stable DB path for `rootPath` under ~/.codebase-graph/<hash8>/. */
export declare function buildDbPath(rootPath: string): string;
/** Constructs a fully-wired GraphToolContext for the given root and DB path. */
export declare function buildContext(rootPath: string, dbPath: string): GraphToolContext;
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
export declare function computeSourceSignature(rootPath: string): string;
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
export declare class LazyIndexGuard {
    private lastCheckAt;
    private lastSignature;
    checkAndIndex(context: GraphToolContext, rootPath: string): Promise<void>;
}
/**
 * Registers all graph tools on the provided low-level Server instance using
 * hand-rolled ListTools and CallTool request handlers.
 *
 * This replaces the former McpServer.registerTool() approach so that the
 * hand-authored TOOL_SCHEMAS in mcpToolHandlers.ts are passed through verbatim
 * in the tools/list response — the McpServer API discarded them in favour of
 * empty Zod-derived schemas (M-60 D1).
 *
 * A shared LazyIndexGuard is created once and wraps every graph-requiring
 * tool call (all tools EXCEPT the LAZY_INIT_BYPASS_TOOLS set).
 */
export declare function registerGraphTools(server: Server, context: GraphToolContext, rootPath: string): void;
//# sourceMappingURL=serverBootstrap.d.ts.map
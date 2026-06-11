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
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CypherEngine } from './cypherEngine.js';
import { GraphDatabase } from './graphDatabase.js';
import { IndexingPipeline } from './indexingPipeline.js';
import { createGraphMcpTools } from './mcpToolHandlers.js';
import { QueryEngine } from './queryEngine.js';
import { TreeSitterParser } from './treeSitterParser.js';
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
/**
 * Silent auto-migration helper: if the legacy `~/.ouroboros-graph/` directory
 * exists, moves it (or its subdirectories) to `~/.codebase-graph/` so that
 * existing 0.1.0 graph data survives a 0.2.0 upgrade without a full reindex.
 *
 * Rules:
 *   - OLD-ONLY: rename the root dir atomically (fs.renameSync). No data loss.
 *   - BOTH EXIST: walk old subdirs; move any that are absent in new; warn for
 *     collisions — leaves both untouched so the user can clean up manually.
 *   - NEW-ONLY or NEITHER: no-op.
 *
 * Uses only fs.renameSync — never fs.rmSync or fs.unlinkSync.
 */
function migrateOuroborosPath(home) {
    const oldRoot = path.join(home, '.ouroboros-graph');
    const newRoot = path.join(home, '.codebase-graph');
    // Neither or new-only: nothing to do.
    if (!fs.existsSync(oldRoot))
        return;
    try {
        // OLD-ONLY fast path: whole-tree rename if new doesn't exist.
        if (!fs.existsSync(newRoot)) {
            try {
                fs.renameSync(oldRoot, newRoot);
                console.error(`[trace:graph-mcp.storage-migrate] moved ${oldRoot} -> ${newRoot}`);
                return;
            }
            catch (err) {
                // Whole-tree rename failed (likely EPERM from open file handles in subdirs).
                // Fall through to subdir-level migration: create newRoot, migrate subdirs that succeed,
                // leave the rest where they are.
                const errCode = err.code ?? err.message;
                console.error(`[trace:graph-mcp.storage-migrate] whole-tree rename failed (${errCode}); ` +
                    `falling back to subdir-by-subdir migration`);
                fs.mkdirSync(newRoot, { recursive: true });
            }
        }
        // Subdir-level migration: walk oldRoot, move each subdir if it doesn't collide in newRoot.
        // Per-subdir try/catch so one failure doesn't block others.
        const oldEntries = fs.readdirSync(oldRoot, { withFileTypes: true });
        const collisions = [];
        const failed = [];
        for (const entry of oldEntries) {
            if (!entry.isDirectory())
                continue;
            const oldSub = path.join(oldRoot, entry.name);
            const newSub = path.join(newRoot, entry.name);
            if (fs.existsSync(newSub)) {
                collisions.push(entry.name);
                // Non-destructive: leave both — user resolves
                continue;
            }
            try {
                fs.renameSync(oldSub, newSub);
            }
            catch (err) {
                const errCode = err.code ?? err.message;
                failed.push(`${entry.name} (${errCode})`);
            }
        }
        if (collisions.length > 0) {
            console.error(`[trace:graph-mcp.storage-migrate] warning: ${collisions.length} hash dir(s) exist in BOTH ` +
                `${oldRoot} AND ${newRoot}: ${collisions.join(', ')}. Using new path. Old data preserved at ` +
                `${oldRoot} — delete manually after confirming new graph is intact.`);
        }
        if (failed.length > 0) {
            console.error(`[trace:graph-mcp.storage-migrate] warning: ${failed.length} hash dir(s) could not be migrated ` +
                `from ${oldRoot}: ${failed.join(', ')}. Likely cause: a file inside is in use by another ` +
                `process. Server will continue with the new path; old data is preserved at the old path.`);
        }
    }
    catch (err) {
        // Top-level safety net: if anything else goes wrong (readdir failure, mkdir failure, etc.),
        // log and continue. Migration is best-effort — server MUST start even if it fails entirely.
        const errCode = err.code ?? err.message;
        console.error(`[trace:graph-mcp.storage-migrate] migration aborted (${errCode}); ` +
            `server continuing with new path. Old data preserved at ${oldRoot}.`);
    }
}
/**
 * Canonicalizes `rootPath` and returns its 8-char storage hash. Pure — no I/O.
 *
 * Folds path-separator style (backslash vs forward-slash), trailing slashes, and
 * drive-letter case so two spellings of the SAME folder map to one DB. Without this,
 * `C:\Web App\X` (from a cwd fallback) and `C:/Web App/X` (from an explicit --root)
 * hash to two directories and index the same project twice.
 */
export function rootHash(rootPath) {
    const canonical = path.resolve(rootPath).replace(/\\/g, '/').toLowerCase();
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}
/** Derives a stable DB path for `rootPath` under ~/.codebase-graph/<hash8>/. */
export function buildDbPath(rootPath) {
    migrateOuroborosPath(os.homedir());
    const dir = path.join(os.homedir(), '.codebase-graph', rootHash(rootPath));
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
function makeLazyPipeline(db, parser) {
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
export function buildContext(rootPath, dbPath) {
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
export function computeSourceSignature(rootPath) {
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', 'vendor', 'target']);
    let fileCount = 0;
    let mtimeSum = 0;
    function walk(dir) {
        if (fileCount >= SIGNATURE_FILE_CAP)
            return;
        let entries;
        try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- rootPath from trusted buildContext call
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return; // Permission error or gone — skip
        }
        for (const entry of entries) {
            if (fileCount >= SIGNATURE_FILE_CAP)
                break;
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) {
                    walk(path.join(dir, entry.name));
                }
            }
            else if (entry.isFile()) {
                try {
                    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from trusted rootPath + readdir entry
                    const stat = fs.statSync(path.join(dir, entry.name));
                    mtimeSum += stat.mtimeMs;
                    fileCount++;
                }
                catch {
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
    lastCheckAt = 0;
    lastSignature = null;
    async checkAndIndex(context, rootPath) {
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
                onProgress: () => { },
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
            onProgress: () => { },
        });
        this.lastSignature = computeSourceSignature(rootPath);
        this.lastCheckAt = Date.now();
    }
}
// ── Tool registration ─────────────────────────────────────────────────────────
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
export function registerGraphTools(server, context, rootPath) {
    const guard = new LazyIndexGuard();
    const tools = createGraphMcpTools(context);
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name } = req.params;
        const args = (req.params.arguments ?? {});
        const def = toolMap.get(name);
        if (!def) {
            return {
                content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }
        console.error(`[trace:graph-mcp.tool.${name}] called`);
        if (!LAZY_INIT_BYPASS_TOOLS.has(name)) {
            await guard.checkAndIndex(context, rootPath);
        }
        return def.handler(args, rootPath);
    });
}
//# sourceMappingURL=serverBootstrap.js.map
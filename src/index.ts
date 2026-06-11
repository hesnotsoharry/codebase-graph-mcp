import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildContext, buildDbPath, registerGraphTools } from './serverBootstrap.js'; // .js needed for Node ESM

// ── CLI arg parsing ────────────────────────────────────────────────────────────

function parseRootArg(): string {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--root');
  if (idx !== -1 && argv[idx + 1]) {
    return argv[idx + 1];
  }
  return process.cwd();
}

// ── --reindex-if-stale mode ────────────────────────────────────────────────────

/**
 * Returns the repository's last-change timestamp in milliseconds.
 *
 * First attempts `git log -1 --format=%ct` (seconds → ms) when the directory
 * is a git repo. Falls back to the max mtime of tracked source files if git
 * is unavailable or the directory is not a git repo.
 */
function getLastChangeTimeMs(rootPath: string): number {
  try {
    const result = execSync('git log -1 --format=%ct', {
      cwd: rootPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    })
      .toString()
      .trim();
    const seconds = parseInt(result, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  } catch {
    // git unavailable or not a git repo — fall through to mtime walk
  }

  // Fallback: max mtime across tracked source files
  const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    '.next',
    '.nuxt',
    'coverage',
    'vendor',
    'target',
  ]);
  let maxMtime = 0;

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- rootPath from CLI arg
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from trusted rootPath
          const stat = fs.statSync(path.join(dir, entry.name));
          if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
        } catch {
          // file vanished or unreadable — skip
        }
      }
    }
  }

  walk(rootPath);
  return maxMtime;
}

/**
 * --reindex-if-stale <rootPath>
 *
 * Checks whether the graph DB for <rootPath> is stale (no project record, or
 * indexed_at < repo last-change time). If stale, runs an incremental index.
 * If fresh, exits silently. Every failure path logs one line to stderr and
 * exits 0 — this is designed to be spawned fire-and-forget from a hook.
 */
async function reindexIfStale(rootPath: string): Promise<void> {
  try {
    const resolvedRoot = path.resolve(rootPath);
    const dbPath = buildDbPath(resolvedRoot);
    const context = buildContext(resolvedRoot, dbPath);

    const project = context.db.getProject(context.projectName);

    let stale: boolean;
    if (!project) {
      console.error(
        `[trace:graph-mcp.reindex-if-stale] no project record for '${context.projectName}' — treating as stale`,
      );
      stale = true;
    } else {
      const lastChangeMs = getLastChangeTimeMs(resolvedRoot);
      stale = lastChangeMs > project.indexed_at;
      if (stale) {
        console.error(
          `[trace:graph-mcp.reindex-if-stale] stale (last-change=${lastChangeMs} indexed_at=${project.indexed_at})`,
        );
      }
    }

    if (stale) {
      await context.pipeline.index({
        projectRoot: resolvedRoot,
        incremental: true,
        onProgress: () => {},
      });
      console.error('[trace:graph-mcp.reindex-if-stale] incremental reindex complete');
    }
  } catch (err) {
    console.error(
      `[trace:graph-mcp.reindex-if-stale] error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  process.exit(0);
}

// ── Bootstrap and connect ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // --reindex-if-stale mode exits after the operation — never starts the MCP transport.
  const reindexIdx = argv.indexOf('--reindex-if-stale');
  if (reindexIdx !== -1) {
    const staleRoot = argv[reindexIdx + 1];
    if (!staleRoot) {
      console.error('[trace:graph-mcp.reindex-if-stale] missing <rootPath> argument');
      process.exit(0);
    }
    await reindexIfStale(staleRoot);
    return; // reindexIfStale calls process.exit(0) — this return is unreachable but satisfies TS
  }

  const rootPath = parseRootArg();
  const dbPath = buildDbPath(rootPath);
  const context = buildContext(rootPath, dbPath);

  // NOTE: tools capability MUST be declared in the constructor (or via
  // registerCapabilities before setRequestHandler) — Protocol.assertRequestHandlerCapability
  // throws at startup otherwise.
  const server = new Server(
    { name: 'codebase-graph-mcp', version: '0.6.0' },
    { capabilities: { tools: {} } },
  );

  // NOTE: ping health-check tool is registered via createGraphMcpTools() inside
  // registerGraphTools() — see mcpToolHandlers.ts buildTypeofAndHealthTools(). Removed
  // the standalone registration here (M-28 Phase 3) to avoid duplicate registration
  // and to surface ping in the McpToolDefinition list (needed by acceptance test D).

  registerGraphTools(server, context, rootPath);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[trace:graph-mcp.server.start] codebase-graph-mcp server listening on stdio');
  console.error(`[trace:graph-mcp.server.start] root=${rootPath} db=${dbPath}`);
}

main().catch((err: unknown) => {
  console.error('[trace:graph-mcp.server.error] fatal error during startup', err);
  process.exit(1);
});

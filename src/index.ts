import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

// ── Server setup ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'codebase-graph-mcp',
  version: '0.2.0',
});

// NOTE: ping health-check tool is now registered via createGraphMcpTools() inside
// registerGraphTools() — see mcpToolHandlers.ts buildTypeofAndHealthTools(). Removed
// the standalone registration here (M-28 Phase 3) to avoid duplicate registration
// and to surface ping in the McpToolDefinition list (needed by acceptance test D).

// ── Bootstrap and connect ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rootPath = parseRootArg();
  const dbPath = buildDbPath(rootPath);
  const context = buildContext(rootPath, dbPath);
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

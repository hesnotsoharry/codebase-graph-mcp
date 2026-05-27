import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

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
  version: '0.1.0',
});

// Health-check tool — must stay for walking-skeleton smoke test.
server.registerTool(
  'ping',
  {
    description: 'Health-check tool — returns pong',
    inputSchema: z.object({}),
  },
  async () => {
    return {
      content: [{ type: 'text' as const, text: 'pong' }],
    };
  },
);

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

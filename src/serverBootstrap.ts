/**
 * serverBootstrap.ts — Context construction and tool registration for the
 * standalone codebase-graph MCP server.
 *
 * Separated from index.ts so each unit stays under the max-lines: 300 cap.
 */

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
 */
export function registerGraphTools(
  server: McpServer,
  context: GraphToolContext,
  rootPath: string,
): void {
  const tools = createGraphMcpTools(context);
  for (const def of tools) {
    const { name, description, handler } = def;
    server.registerTool(
      name,
      { description, inputSchema: anyArgs },
      async (args: Record<string, unknown>) => {
        console.error(`[trace:graph-mcp.tool.${name}] called`);
        return handler(args ?? {}, rootPath) as Promise<CallToolResult>;
      },
    );
  }
}

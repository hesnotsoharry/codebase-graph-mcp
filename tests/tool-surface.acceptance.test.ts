// Orchestrator-owned acceptance test for Wave 22 Phase 4 (full MCP tool surface).
// Per ~/.claude/rules-deferred/orchestrator-owned-acceptance-tests.md:
// THE IMPLEMENTER MAY NOT MODIFY THIS FILE.
//
// Contract: the compiled standalone MCP server at packages/codebase-graph-mcp/dist/index.js
// MUST advertise and serve the six canonical tools:
//   search_graph, query_graph, trace_call_path, get_code_snippet, detect_changes, manage_adr
//
// The server is invoked with `--root <path-to-acceptance-fixture>`. The fixture is a
// tiny two-file TS project under tests/acceptance-fixture/ that gives the indexer real
// symbols (Greeter class, createGreeter function, Inventory class) to populate the graph.
//
// The test speaks raw JSON-RPC over stdio (newline-delimited) so it does not depend on
// which SDK exports are stable in the implementer's chosen @modelcontextprotocol/sdk version.
//
// Strategy: assert SHAPE strictly (every tool returns content[].text non-empty; no
// JSON-RPC error envelope on the wire) and assert CONTENT loosely (a known symbol name
// shows up in search_graph / get_code_snippet / trace_call_path output; the rest is
// shape-only because the response format is plain text and could legitimately change
// wording across patch versions of the formatters).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');
const FIXTURE_ROOT = path.resolve(__dirname, 'acceptance-fixture');

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpStdioClient {
  private child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private pending = new Map<number, (msg: JsonRpcMessage) => void>();
  private nextId = 1;

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf-8');
    this.child.stdout.on('data', (chunk: string) => this.onStdoutData(chunk));
    this.child.stderr.setEncoding('utf-8');
    this.child.stderr.on('data', (chunk: string) => {
      // Surface boot logs ([trace:graph-mcp.server.start]) and any runtime errors.
      process.stderr.write(`[server-stderr] ${chunk}`);
    });
  }

  private onStdoutData(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl = this.stdoutBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
            const resolver = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            resolver?.(msg);
          }
        } catch {
          process.stderr.write(`[server-stdout-nonjson] ${line}\n`);
        }
      }
      nl = this.stdoutBuffer.indexOf('\n');
    }
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      this.pending.set(id, resolve);
      const msg: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request '${method}' (id=${id}) timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
  }

  notify(method: string, params: unknown): void {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', method, params };
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  close(): void {
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    this.child.kill();
  }
}

interface ToolListEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function expectTextResult(resp: JsonRpcMessage, toolName: string): ToolCallResult {
  expect(
    resp.error,
    `tools/call ${toolName} returned a JSON-RPC error envelope: ${JSON.stringify(resp.error)}`,
  ).toBeUndefined();
  expect(resp.result, `tools/call ${toolName} returned no result`).toBeDefined();
  const result = resp.result as ToolCallResult;
  expect(Array.isArray(result.content), `tools/call ${toolName} content not an array`).toBe(true);
  expect(result.content.length, `tools/call ${toolName} content empty`).toBeGreaterThan(0);
  expect(result.content[0]?.type, `tools/call ${toolName} content[0].type not 'text'`).toBe('text');
  expect(
    typeof result.content[0]?.text,
    `tools/call ${toolName} content[0].text not a string`,
  ).toBe('string');
  expect(
    result.content[0]?.text.length,
    `tools/call ${toolName} content[0].text empty`,
  ).toBeGreaterThan(0);
  return result;
}

const REQUIRED_TOOLS = [
  'search_graph',
  'query_graph',
  'trace_call_path',
  'get_code_snippet',
  'detect_changes',
  'manage_adr',
] as const;

describe('Wave 22 Phase 4 — full MCP tool surface acceptance', () => {
  let client: McpStdioClient;

  beforeAll(async () => {
    client = new McpStdioClient('node', [SERVER_PATH, '--root', FIXTURE_ROOT]);

    const initResp = await client.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'wave-22-tool-surface-acceptance', version: '1.0.0' },
      },
      15_000,
    );
    expect(
      initResp.error,
      `initialize returned an error: ${JSON.stringify(initResp.error)}`,
    ).toBeUndefined();
    client.notify('notifications/initialized', {});

    // Index the fixture project so the graph has nodes to query.
    // Generous timeout: cold start includes tree-sitter WASM load + better-sqlite3 init.
    const indexResp = await client.request(
      'tools/call',
      { name: 'index_repository', arguments: { repo_path: FIXTURE_ROOT } },
      60_000,
    );
    expectTextResult(indexResp, 'index_repository (bootstrap)');
  }, 90_000);

  afterAll(() => {
    client?.close();
  });

  it('tools/list advertises all six required tools', async () => {
    const listResp = await client.request('tools/list', {});
    expect(
      listResp.error,
      `tools/list returned an error: ${JSON.stringify(listResp.error)}`,
    ).toBeUndefined();
    const tools = (listResp.result as { tools: ToolListEntry[] }).tools;
    expect(Array.isArray(tools), 'tools/list result must contain a tools array').toBe(true);
    const toolNames = new Set(tools.map((t) => t.name));
    for (const required of REQUIRED_TOOLS) {
      expect(
        toolNames.has(required),
        `tools/list missing '${required}'. Advertised: ${[...toolNames].sort().join(', ')}`,
      ).toBe(true);
    }
  });

  it('search_graph returns results mentioning the fixture symbol "Greeter"', async () => {
    const resp = await client.request('tools/call', {
      name: 'search_graph',
      arguments: { query: 'Greeter' },
    });
    const result = expectTextResult(resp, 'search_graph');
    expect(
      result.content[0].text,
      `search_graph for 'Greeter' should mention the symbol in its results, got: ${result.content[0].text.slice(0, 400)}`,
    ).toMatch(/Greeter/);
  });

  it('get_code_snippet returns a snippet for "Greeter"', async () => {
    const resp = await client.request('tools/call', {
      name: 'get_code_snippet',
      arguments: { symbol: 'Greeter' },
    });
    const result = expectTextResult(resp, 'get_code_snippet');
    // Snippet text should reference the symbol name or its source file.
    expect(
      result.content[0].text,
      `get_code_snippet for 'Greeter' should mention the symbol or its file, got: ${result.content[0].text.slice(0, 400)}`,
    ).toMatch(/Greeter|greeter\.ts/);
  });

  it('trace_call_path returns a well-formed response for "Greeter"', async () => {
    const resp = await client.request('tools/call', {
      name: 'trace_call_path',
      arguments: { symbol: 'Greeter', direction: 'both' },
    });
    const result = expectTextResult(resp, 'trace_call_path');
    // Discriminating check: must NOT be the SDK's "tool not found" sentinel.
    // Trace results on a tiny fixture may legitimately be empty or small; the
    // contract is "the tool exists and responds", not "specific edges returned."
    expect(
      result.content[0].text,
      `trace_call_path returned the SDK 'tool not found' sentinel, meaning the tool isn't wired. Got: ${result.content[0].text.slice(0, 200)}`,
    ).not.toMatch(/Tool .* not found/);
  });

  it('query_graph accepts a Cypher-like query and returns text', async () => {
    const resp = await client.request('tools/call', {
      name: 'query_graph',
      arguments: { query: 'MATCH (n:Class) RETURN n.name LIMIT 5' },
    });
    const result = expectTextResult(resp, 'query_graph');
    expect(
      result.content[0].text,
      `query_graph returned the SDK 'tool not found' sentinel. Got: ${result.content[0].text.slice(0, 200)}`,
    ).not.toMatch(/Tool .* not found/);
  });

  it('detect_changes returns a well-formed response', async () => {
    const resp = await client.request('tools/call', {
      name: 'detect_changes',
      arguments: { scope: 'all' },
    });
    const result = expectTextResult(resp, 'detect_changes');
    // Fixture is not a git repo, so detect_changes may legitimately respond with
    // a git-related error inside the content text. The contract is "the tool
    // exists and responds", not "git is happy." Discriminate from "tool not found."
    expect(
      result.content[0].text,
      `detect_changes returned the SDK 'tool not found' sentinel. Got: ${result.content[0].text.slice(0, 200)}`,
    ).not.toMatch(/Tool .* not found/);
  });

  it('manage_adr list mode returns a well-formed response', async () => {
    const resp = await client.request('tools/call', {
      name: 'manage_adr',
      arguments: { mode: 'list' },
    });
    const result = expectTextResult(resp, 'manage_adr');
    expect(
      result.content[0].text,
      `manage_adr returned the SDK 'tool not found' sentinel. Got: ${result.content[0].text.slice(0, 200)}`,
    ).not.toMatch(/Tool .* not found/);
  });
});

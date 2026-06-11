// ORCHESTRATOR-AUTHORED ACCEPTANCE ORACLE (wave M-60 P1). THE IMPLEMENTER MAY NOT MODIFY THIS FILE.
//
// Contract: the MCP server's tools/list response MUST include inputSchema definitions for every
// tool except ['list_projects', 'get_graph_schema', 'ping']. Each such tool's inputSchema MUST
// have a properties object with at least one key. Specific tools have additional shape constraints:
//   - index_repository: properties must include 'repo_path'
//   - query_graph: properties must include 'query'; required must include 'query'
//   - search_graph: properties must include 'query'; properties.relationship must preserve oneOf with ≥2 items
//   - get_code_snippet: required must include 'symbol'
//   - trace_call_path: required must include 'symbol'
//   - get_architecture: properties must NOT include 'project'
//
// tools/call with an unknown tool name must return an error response that indicates the tool
// is unknown, but does NOT match the /Tool .* not found/ sentinel pattern.

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

describe('Wave M-60 P1 — MCP tool schema wire', () => {
  let client: McpStdioClient;

  beforeAll(async () => {
    client = new McpStdioClient('node', [SERVER_PATH, '--root', FIXTURE_ROOT]);

    const initResp = await client.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'schema-wire-acceptance', version: '1.0.0' },
      },
      15_000,
    );
    expect(
      initResp.error,
      `initialize returned an error: ${JSON.stringify(initResp.error)}`,
    ).toBeUndefined();
    client.notify('notifications/initialized', {});

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

  it('tools/list: every tool except [list_projects, get_graph_schema, ping] has inputSchema.properties with ≥1 key', async () => {
    const listResp = await client.request('tools/list', {});
    expect(listResp.error).toBeUndefined();
    const tools = (listResp.result as { tools: ToolListEntry[] }).tools;
    expect(Array.isArray(tools)).toBe(true);

    const skipped = new Set(['list_projects', 'get_graph_schema', 'ping']);
    for (const tool of tools) {
      if (skipped.has(tool.name)) {
        continue;
      }
      expect(
        tool.inputSchema,
        `tool '${tool.name}' does not have inputSchema`,
      ).toBeDefined();
      const inputSchema = tool.inputSchema as Record<string, unknown>;
      expect(
        inputSchema.properties,
        `tool '${tool.name}' inputSchema has no properties`,
      ).toBeDefined();
      const properties = inputSchema.properties as Record<string, unknown>;
      const propCount = Object.keys(properties).length;
      expect(
        propCount,
        `tool '${tool.name}' inputSchema.properties is empty (got 0 keys)`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('index_repository has property repo_path in inputSchema', async () => {
    const listResp = await client.request('tools/list', {});
    expect(listResp.error).toBeUndefined();
    const tools = (listResp.result as { tools: ToolListEntry[] }).tools;
    const indexRepoTool = tools.find((t) => t.name === 'index_repository');
    expect(indexRepoTool, 'index_repository tool not found in tools/list').toBeDefined();
    const inputSchema = indexRepoTool!.inputSchema as Record<string, unknown>;
    const properties = inputSchema.properties as Record<string, unknown>;
    expect(
      Object.keys(properties).includes('repo_path'),
      `index_repository inputSchema.properties missing 'repo_path'. Keys: ${Object.keys(properties).join(', ')}`,
    ).toBe(true);
  });

  it('query_graph has property query in inputSchema AND query is in required', async () => {
    const listResp = await client.request('tools/list', {});
    expect(listResp.error).toBeUndefined();
    const tools = (listResp.result as { tools: ToolListEntry[] }).tools;
    const queryGraphTool = tools.find((t) => t.name === 'query_graph');
    expect(queryGraphTool, 'query_graph tool not found in tools/list').toBeDefined();
    const inputSchema = queryGraphTool!.inputSchema as Record<string, unknown>;
    const properties = inputSchema.properties as Record<string, unknown>;
    expect(
      Object.keys(properties).includes('query'),
      `query_graph inputSchema.properties missing 'query'. Keys: ${Object.keys(properties).join(', ')}`,
    ).toBe(true);
    const required = inputSchema.required as string[];
    expect(
      Array.isArray(required) && required.includes('query'),
      `query_graph inputSchema.required does not include 'query' (got: ${JSON.stringify(required)})`,
    ).toBe(true);
  });

  it('search_graph has property query and relationship with oneOf array of length ≥2', async () => {
    const listResp = await client.request('tools/list', {});
    expect(listResp.error).toBeUndefined();
    const tools = (listResp.result as { tools: ToolListEntry[] }).tools;
    const searchGraphTool = tools.find((t) => t.name === 'search_graph');
    expect(searchGraphTool, 'search_graph tool not found in tools/list').toBeDefined();
    const inputSchema = searchGraphTool!.inputSchema as Record<string, unknown>;
    const properties = inputSchema.properties as Record<string, unknown>;
    expect(
      Object.keys(properties).includes('query'),
      `search_graph inputSchema.properties missing 'query'. Keys: ${Object.keys(properties).join(', ')}`,
    ).toBe(true);
    const relationshipProp = properties.relationship as Record<string, unknown>;
    expect(
      relationshipProp,
      `search_graph inputSchema.properties.relationship not found`,
    ).toBeDefined();
    const oneOf = relationshipProp.oneOf as Array<unknown>;
    expect(
      Array.isArray(oneOf),
      `search_graph.relationship.oneOf is not an array. Got: ${JSON.stringify(relationshipProp)}`,
    ).toBe(true);
    expect(
      oneOf.length,
      `search_graph.relationship.oneOf length < 2. Got: ${oneOf.length}`,
    ).toBeGreaterThanOrEqual(2);
  });

  it('get_code_snippet has symbol in required', async () => {
    const listResp = await client.request('tools/list', {});
    expect(listResp.error).toBeUndefined();
    const tools = (listResp.result as { tools: ToolListEntry[] }).tools;
    const getCodeSnippetTool = tools.find((t) => t.name === 'get_code_snippet');
    expect(getCodeSnippetTool, 'get_code_snippet tool not found in tools/list').toBeDefined();
    const inputSchema = getCodeSnippetTool!.inputSchema as Record<string, unknown>;
    const required = inputSchema.required as string[];
    expect(
      Array.isArray(required) && required.includes('symbol'),
      `get_code_snippet inputSchema.required does not include 'symbol'. Got: ${JSON.stringify(required)}`,
    ).toBe(true);
  });

  it('trace_call_path has symbol in required', async () => {
    const listResp = await client.request('tools/list', {});
    expect(listResp.error).toBeUndefined();
    const tools = (listResp.result as { tools: ToolListEntry[] }).tools;
    const traceCallPathTool = tools.find((t) => t.name === 'trace_call_path');
    expect(traceCallPathTool, 'trace_call_path tool not found in tools/list').toBeDefined();
    const inputSchema = traceCallPathTool!.inputSchema as Record<string, unknown>;
    const required = inputSchema.required as string[];
    expect(
      Array.isArray(required) && required.includes('symbol'),
      `trace_call_path inputSchema.required does not include 'symbol'. Got: ${JSON.stringify(required)}`,
    ).toBe(true);
  });

  it('get_architecture inputSchema.properties does NOT include project', async () => {
    const listResp = await client.request('tools/list', {});
    expect(listResp.error).toBeUndefined();
    const tools = (listResp.result as { tools: ToolListEntry[] }).tools;
    const getArchTool = tools.find((t) => t.name === 'get_architecture');
    expect(getArchTool, 'get_architecture tool not found in tools/list').toBeDefined();
    const inputSchema = getArchTool!.inputSchema as Record<string, unknown>;
    const properties = inputSchema.properties as Record<string, unknown>;
    expect(
      !Object.keys(properties).includes('project'),
      `get_architecture inputSchema.properties should NOT include 'project'. Keys: ${Object.keys(properties).join(', ')}`,
    ).toBe(true);
  });

  it('tools/call with unknown tool name returns error without matching "Tool .* not found" pattern', async () => {
    const unknownResp = await client.request('tools/call', {
      name: 'nonexistent_tool_xyz_9999',
      arguments: {},
    });

    const hasError =
      unknownResp.error !== undefined || (unknownResp.result as Record<string, unknown>)?.isError === true;
    expect(
      hasError,
      `tools/call with unknown tool should return an error. Got: ${JSON.stringify(unknownResp)}`,
    ).toBe(true);

    let errorText = '';
    if (unknownResp.error) {
      errorText = unknownResp.error.message;
    } else if ((unknownResp.result as Record<string, unknown>)?.content) {
      const content = (unknownResp.result as Record<string, unknown>).content as Array<{ text?: string }>;
      if (Array.isArray(content) && content[0]?.text) {
        errorText = content[0].text;
      }
    }
    expect(
      errorText,
      `error text should not match the "Tool X not found" sentinel pattern. Got: ${errorText}`,
    ).not.toMatch(/Tool .* not found/);
  });
});

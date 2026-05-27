// Orchestrator-owned acceptance test for Wave 22 Phase 1 (walking skeleton).
// Per ~/.claude/rules-deferred/orchestrator-owned-acceptance-tests.md:
// THE IMPLEMENTER MAY NOT MODIFY THIS FILE.
//
// Contract: the compiled standalone MCP server at packages/codebase-graph-mcp/dist/index.js
// MUST accept the canonical MCP stdio handshake and respond to a `ping` tool call with `pong`.
//
// The test speaks raw JSON-RPC over stdio (newline-delimited) so it does not depend on
// which SDK exports are stable in the implementer's chosen @modelcontextprotocol/sdk version.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

const SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

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
    // Surface child stderr to test output so server boot logs (e.g. [trace:graph-mcp.server.start])
    // are visible when the test is run with vitest --reporter verbose.
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
          // Non-JSON line on stdout is a protocol violation — the test will time out
          // waiting for a real response; surface for debugging.
          process.stderr.write(`[server-stdout-nonjson] ${line}\n`);
        }
      }
      nl = this.stdoutBuffer.indexOf('\n');
    }
  }

  request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      this.pending.set(id, resolve);
      const msg: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request '${method}' (id=${id}) timed out after 8s`));
        }
      }, 8000);
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

describe('Wave 22 Phase 1 — walking-skeleton smoke', () => {
  it('the compiled standalone MCP server speaks the canonical handshake and `ping` returns `pong`', async () => {
    const client = new McpStdioClient('node', [SERVER_PATH]);

    try {
      // 1. initialize handshake
      const initResp = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'wave-22-walking-skeleton-smoke', version: '1.0.0' },
      });
      expect(initResp.error, `initialize returned an error: ${JSON.stringify(initResp.error)}`).toBeUndefined();
      expect(initResp.result, 'initialize must return a result').toBeDefined();

      // 2. initialized notification (no response)
      client.notify('notifications/initialized', {});

      // 3. tools/list — `ping` must be advertised
      const listResp = await client.request('tools/list', {});
      expect(listResp.error, `tools/list returned an error: ${JSON.stringify(listResp.error)}`).toBeUndefined();
      const tools = (listResp.result as { tools: Array<{ name: string }> }).tools;
      expect(Array.isArray(tools), 'tools/list result must contain a tools array').toBe(true);
      const toolNames = tools.map((t) => t.name);
      expect(toolNames, `expected 'ping' in advertised tools, got: ${toolNames.join(', ')}`).toContain('ping');

      // 4. tools/call ping → pong
      const pingResp = await client.request('tools/call', {
        name: 'ping',
        arguments: {},
      });
      expect(pingResp.error, `tools/call ping returned an error: ${JSON.stringify(pingResp.error)}`).toBeUndefined();
      const content = (pingResp.result as { content: Array<{ type: string; text: string }> }).content;
      expect(Array.isArray(content), 'tools/call ping result must have a content array').toBe(true);
      expect(content[0]).toMatchObject({ type: 'text', text: 'pong' });
    } finally {
      client.close();
    }
  }, 15000);
});

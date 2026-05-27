#!/usr/bin/env node
/**
 * smoke-probe.mjs — Wave 22 Phase 6 cross-project smoke probe.
 *
 * Spawns the compiled standalone MCP server against a given --root, calls
 * `index_repository` to populate the graph, then issues a sample `search_graph`
 * query and reports the latency of each call. Output is structured plain text
 * suitable for inclusion in a wave smoke report.
 *
 * Usage:
 *   node scripts/smoke-probe.mjs --root <project-path> [--symbol <SymbolName>]
 *
 * Exits 0 on success, 1 on protocol error or timeout.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = { root: process.cwd(), symbol: 'main' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) {
      out.root = path.resolve(argv[++i]);
    } else if (argv[i] === '--symbol' && argv[i + 1]) {
      out.symbol = argv[++i];
    }
  }
  return out;
}

class McpClient {
  constructor(command, args) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf-8');
    this.child.stderr.setEncoding('utf-8');
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderrLines = [];
    this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderrLines.push(chunk);
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          const resolver = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolver(msg);
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  }

  request(method, params, timeoutMs = 600_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request '${method}' (id=${id}) timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {}
    this.child.kill();
  }
}

async function main() {
  const { root, symbol } = parseArgs();

  if (!fs.existsSync(root)) {
    console.error(`[smoke] root does not exist: ${root}`);
    process.exit(1);
  }
  if (!fs.existsSync(SERVER_PATH)) {
    console.error(`[smoke] server not built: ${SERVER_PATH}`);
    process.exit(1);
  }

  console.log(`[smoke] root=${root}`);
  console.log(`[smoke] server=${SERVER_PATH}`);
  console.log(`[smoke] sample symbol=${symbol}`);

  const client = new McpClient('node', [SERVER_PATH, '--root', root]);

  try {
    // 1. initialize
    let t0 = Date.now();
    const init = await client.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'wave-22-phase-6-smoke', version: '1.0.0' },
      },
      30_000,
    );
    const initMs = Date.now() - t0;
    if (init.error) {
      console.error(`[smoke] initialize failed: ${JSON.stringify(init.error)}`);
      process.exit(1);
    }
    client.notify('notifications/initialized', {});
    console.log(`[smoke] initialize: ${initMs}ms`);

    // 2. tools/list — confirm 6+ tool surface
    t0 = Date.now();
    const list = await client.request('tools/list', {});
    const listMs = Date.now() - t0;
    const toolNames = (list.result?.tools ?? []).map((t) => t.name);
    console.log(`[smoke] tools/list: ${listMs}ms, ${toolNames.length} tools advertised`);
    const required = ['search_graph', 'query_graph', 'trace_call_path', 'get_code_snippet', 'detect_changes', 'manage_adr'];
    const missing = required.filter((n) => !toolNames.includes(n));
    if (missing.length) {
      console.error(`[smoke] tools/list missing: ${missing.join(', ')}`);
    }

    // 3. index_repository (cold or incremental)
    t0 = Date.now();
    const index = await client.request(
      'tools/call',
      { name: 'index_repository', arguments: { repo_path: root } },
      14_400_000, // 4-hour relief-valve cap per wave plan
    );
    const indexMs = Date.now() - t0;
    const indexText = (index.result?.content ?? [])[0]?.text ?? '';
    console.log(`[smoke] index_repository: ${indexMs}ms`);
    console.log(`[smoke] index summary: ${indexText.slice(0, 500)}`);

    // 4. search_graph for the sample symbol
    t0 = Date.now();
    const search = await client.request(
      'tools/call',
      { name: 'search_graph', arguments: { query: symbol } },
      60_000,
    );
    const searchMs = Date.now() - t0;
    const searchText = (search.result?.content ?? [])[0]?.text ?? '';
    console.log(`[smoke] search_graph('${symbol}'): ${searchMs}ms`);
    console.log(`[smoke] search result (first 600 chars): ${searchText.slice(0, 600)}`);

    // 5. index_status — confirm node count
    t0 = Date.now();
    const status = await client.request(
      'tools/call',
      { name: 'index_status', arguments: {} },
      30_000,
    );
    const statusMs = Date.now() - t0;
    const statusText = (status.result?.content ?? [])[0]?.text ?? '';
    console.log(`[smoke] index_status: ${statusMs}ms`);
    console.log(`[smoke] status summary: ${statusText.slice(0, 400)}`);

    console.log('\n[smoke] === SUMMARY ===');
    console.log(`root: ${root}`);
    console.log(`initialize: ${initMs}ms`);
    console.log(`tools/list: ${listMs}ms (${toolNames.length} tools)`);
    console.log(`index_repository: ${indexMs}ms`);
    console.log(`search_graph: ${searchMs}ms`);
    console.log(`index_status: ${statusMs}ms`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(`[smoke] fatal:`, err);
  process.exit(1);
});

# @hesnotsoharry/codebase-graph-mcp

Standalone MCP server for codebase graph queries: tree-sitter parsing, SQLite persistence, AST + call-graph traversal.

## Requirements

- Node.js >= 20.0.0

## Quickstart

### macOS / Linux

```bash
# Register with Claude Code at user scope (available in all sessions)
claude mcp add --transport stdio --scope user codebase_graph -- npx -y @hesnotsoharry/codebase-graph-mcp
```

### Windows

`npx -y` does **not** work reliably on Windows. Windows `spawn` does not resolve `.cmd` shims without `shell: true`, which Claude Code's MCP runner does not pass — CVE-2024-27980 made this regress further.

Use the Windows-canonical pattern instead:

```powershell
# Step 1 — install globally
npm install -g @hesnotsoharry/codebase-graph-mcp

# Step 2 — register via direct node invocation (PowerShell)
claude mcp add --scope user codebase_graph node "$(npm root -g)\@hesnotsoharry\codebase-graph-mcp\dist\index.js"
```

If you hit a `✗ Failed to connect` error after registering, see [Troubleshooting](#troubleshooting) and the [Windows registration failure](https://github.com/hesnotsoharry/codebase-graph-mcp/issues/new?template=windows-spawn.yml) issue template.

## Configuration

### Scope options

**User scope** (recommended — available in every Claude Code session on this machine):

```bash
# macOS / Linux
claude mcp add --transport stdio --scope user codebase_graph -- npx -y @hesnotsoharry/codebase-graph-mcp

# Windows
claude mcp add --scope user codebase_graph node "$(npm root -g)\@hesnotsoharry\codebase-graph-mcp\dist\index.js"
```

**Project scope** (checked into repo; shared with collaborators via `.claude/settings.json`):

```bash
# macOS / Linux
claude mcp add --transport stdio --scope project codebase_graph -- npx -y @hesnotsoharry/codebase-graph-mcp

# Windows — substitute the absolute path from Step 2 above
claude mcp add --scope project codebase_graph node "C:\path\to\node_modules\@hesnotsoharry\codebase-graph-mcp\dist\index.js"
```

> **Server-name convention:** use `codebase_graph` (underscore, not hyphen). Claude Code's `execute_code` codemode accesses tools via `servers.<name>.<tool>` — hyphens break JavaScript property access. The tools surface as `mcp__codebase_graph__*` in a Claude Code session.

### Verify the connection

```bash
claude mcp list
```

Expected output:

```
codebase_graph: node C:\...\dist\index.js  ✓ Connected
```

### Introspect the tool surface

In any Claude Code session, ask Claude to list the available MCP tools — or call `mcp__codebase_graph__ping` to confirm the server is reachable. The full input schemas are returned when tools are introspected live; the table below gives one-line descriptions only.

## Tool surface

Tools are grouped by category. For full input schemas, introspect via Claude Code's tool listing.

### Project management

| Tool | Description |
|------|-------------|
| `list_projects` | List all indexed projects known to the graph database. |
| `delete_project` | Remove a project and all its graph data from the database. |

### Indexing

| Tool | Description |
|------|-------------|
| `index_repository` | Trigger a full or incremental index of the target repository. |
| `index_status` | Return the current index state: node count, last-indexed timestamp, staleness flag. |
| `ingest_traces` | Ingest externally-captured call traces to supplement AST-derived call edges. |

### Search

| Tool | Description |
|------|-------------|
| `search_graph` | Fuzzy symbol search over indexed nodes (functions, classes, interfaces, variables). |
| `search_code` | Regex-based text search across source files in the indexed repository. |
| `get_code_snippet` | Retrieve the source snippet and direct dependencies for a specific symbol ID. |

### Traversal

| Tool | Description |
|------|-------------|
| `trace_call_path` | BFS call-path between two symbol IDs — returns the shortest call chain. |
| `get_architecture` | High-level architectural view: hotspots, module clusters, file tree summary. |
| `detect_changes` | Files and symbols changed since the last index run. |

### Schema introspection

| Tool | Description |
|------|-------------|
| `get_graph_schema` | Return the graph's node labels, edge types, and property keys. |
| `query_graph` | Execute a simplified Cypher-subset query against the graph database. |

### ADR

| Tool | Description |
|------|-------------|
| `manage_adr` | Create, list, or retrieve Architecture Decision Records stored alongside the project. |

### Health

| Tool | Description |
|------|-------------|
| `ping` | Health check — returns `pong`. Use to verify the server is connected and responding. |

## Indexing model

The server detects the project root from its working directory at startup. **An explicit `index_repository` call is currently required before queries return meaningful results** — the server does not auto-index on first query. Lazy auto-init (index on first non-ping query if the project is cold) is on the roadmap for v0.2.0; track it at [GitHub Issues](https://github.com/hesnotsoharry/codebase-graph-mcp/issues).

Graph data is persisted at:

```
~/.ouroboros-graph/<project-hash>/graph.db
```

This storage path is scheduled to rename to a neutral location in v0.2.0.

### Incremental indexing

After the initial index, the server watches for file changes via `@parcel/watcher` and triggers incremental reindex automatically. You only need to call `index_repository` explicitly for the first index or after a major structural change (e.g., a large branch merge).

## Troubleshooting

### `✗ Failed to connect` on Windows

You are likely hitting the `npx.cmd` spawn issue. Switch to the `node <absolute-path>` pattern:

```powershell
npm install -g @hesnotsoharry/codebase-graph-mcp
claude mcp add --scope user codebase_graph node "$(npm root -g)\@hesnotsoharry\codebase-graph-mcp\dist\index.js"
```

If this still fails, file an issue using the [Windows registration failure](https://github.com/hesnotsoharry/codebase-graph-mcp/issues/new?template=windows-spawn.yml) template — it prompts for the diagnostics needed to triage the specific failure.

### Empty graph results after connecting

The server is connected but the project has not been indexed yet. Call `index_repository` first:

```
mcp__codebase_graph__index_repository
```

Then verify with `index_status` — look for a non-zero node count.

### Tool not appearing in Claude Code

The server did not start successfully. Check `claude mcp list` — if the status is not `✓ Connected`, the server process exited before the tool handshake completed.

Common causes:
- Wrong path to `dist/index.js` (verify the file exists at the registered path)
- Node version below 20 (`node --version` must be `>= 20.0.0`)
- Permission denied on the database directory (`~/.ouroboros-graph/` must be writable)

### Node version mismatch

The package requires Node >= 20. Confirm with:

```bash
node --version
```

If you have multiple Node versions installed (via nvm, volta, or nvm-windows), ensure the version Claude Code inherits from your environment is >= 20. The MCP server is started with the Node that is in `PATH` at Claude Code launch time — not the version active in your current terminal.

## Verification

After registration, run:

```bash
claude mcp list
```

Expected output (Windows shown; Linux/macOS path differs):

```
codebase_graph: node C:\Users\YOU\AppData\Roaming\npm\node_modules\@hesnotsoharry\codebase-graph-mcp\dist\index.js  ✓ Connected
```

Tools surface as `mcp__codebase_graph__*` in Claude Code sessions (underscore namespace, not hyphen — JavaScript object-key compatibility).

## Logging

Diagnostic logs are written to **stderr** only. The server never writes to stdout — stdout is reserved for the MCP JSON-RPC protocol stream. Any `console.log` to stdout would corrupt the protocol and break the connection.

Look for `[trace:graph-mcp.*]` prefixed lines in stderr when debugging.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the issue policy, PR workflow, and solo-maintenance notes.

## License

[MIT](LICENSE) — Copyright (c) 2026 Cole Stacey

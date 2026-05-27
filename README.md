# @hesnotsoharry/codebase-graph-mcp

Standalone MCP server exposing the Ouroboros codebase graph. Consumable from any Claude Code session via `npx` — no Agent IDE installation required.

## Requirements

- Node.js >= 20.0.0

## Invocation

### Via npx (after npm publish)

```bash
npx @hesnotsoharry/codebase-graph-mcp --root /path/to/your/project
```

### Local (during development / pre-publish)

```bash
node packages/codebase-graph-mcp/dist/index.js --root /path/to/your/project
```

## Claude Code configuration

Add this block to your project's `.claude/settings.local.json` (gitignored — local only):

```json
{
  "mcpServers": {
    "codebase-graph-mcp": {
      "type": "stdio",
      "command": "node",
      "args": [
        "packages/codebase-graph-mcp/dist/index.js",
        "--root",
        "${workspaceRoot}"
      ]
    }
  }
}
```

After adding the block, restart your Claude Code session. The tools will surface as `mcp__codebase-graph-mcp__*` in any agent conversation.

## Build instructions

```bash
cd packages/codebase-graph-mcp
npm install
npm run build
# Output: dist/index.js
```

## Logging

This server writes diagnostic logs to **stderr** (`console.error`). It never writes to stdout — stdout is reserved for the MCP JSON-RPC protocol. Any `console.log` on stdout would corrupt the protocol stream and break the connection.

Look for `[trace:graph-mcp.*]` prefixed lines in stderr when debugging.

## Tool surface (Phase 1 — walking skeleton)

| Tool | Description |
|------|-------------|
| `ping` | Health-check — returns `pong`. Useful for verifying the server is connected. |

Additional tools (`search_graph`, `query_graph`, `trace_call_path`, `get_code_snippet`, `detect_changes`, `manage_adr`) are added in Wave 22 Phase 4.

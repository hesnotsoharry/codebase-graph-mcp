# Contributing

Thanks for your interest in `@hesnotsoharry/codebase-graph-mcp`.

## Status

This package is **solo-maintained** as a side project. Issues are welcome and triaged when time permits — usually within a week, but no SLA. Pull requests are accepted on a case-by-case basis; please open an issue first to discuss anything beyond a typo fix or small bug, so we can decide together whether the change fits the package's scope before you invest time.

## Reporting issues

Use one of the issue templates:

- **Bug report** — something broken or behaving unexpectedly
- **Feature request** — capability you'd like added or extended
- **Windows registration failure** — `claude mcp list` shows `✗ Failed to connect`, `ENOENT`, or similar after registering on Windows (Windows has known spawn-resolution quirks; the template captures the right diagnostics upfront)

Free-form issues are also fine if none of the templates fit.

## Pull requests

Before opening a PR:

1. Open an issue (or comment on an existing one) so we can confirm the change is in scope before you build it.
2. Read [`README.md`](README.md) end-to-end if you haven't — many implementation questions are answered there or in the linked sources.
3. Run the local gates before pushing:

   ```bash
   npm ci
   npm run build
   npm test
   ```

   CI runs the same on Node 20 + 22 across ubuntu-latest + windows-latest. **Windows must pass** — Windows is a first-class platform for this package because the most common consumer (Claude Code via `claude mcp add`) uses Windows-canonical invocation patterns that fail in subtle ways without explicit Windows CI coverage.

4. Match the existing code style. The project uses TypeScript with the conventions enforced by `tsconfig.json`. There is no separate prettier config — `tsc` is the formatter floor.

## Development setup

```bash
git clone https://github.com/hesnotsoharry/codebase-graph-mcp.git
cd codebase-graph-mcp
npm ci
npm run build
npm test
```

The build produces `dist/index.js`. Test it locally without publishing:

```bash
# In a separate terminal — point Claude Code at the local build
claude mcp add --scope user codebase-graph-mcp-dev node "$(pwd)/dist/index.js"
```

See `README.md` § Configuration for production registration patterns.

## Scope

In scope:

- MCP server tools that query the codebase graph (search, trace, architecture, change-detection, ADR management)
- Indexing pipeline improvements (tree-sitter parser coverage, edge resolution, performance)
- Storage layer changes (SQLite schema evolution, query performance)
- Cross-platform reliability (especially Windows)

Out of scope:

- Language-server-protocol features (not the purpose of this server; use a real LSP)
- IDE-specific integrations beyond the standard MCP transport (the server is intentionally framework-agnostic)
- AI-assisted code modification (the server is read-only by design)

## License

By contributing, you agree your contributions will be licensed under the [MIT License](LICENSE).

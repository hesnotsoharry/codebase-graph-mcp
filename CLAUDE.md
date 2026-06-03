# codebase-graph-mcp — Claude Code Instructions

MCP server that builds a code knowledge graph (SQLite-backed) from a repository via tree-sitter + an opt-in ts-morph precision pass, exposing graph query tools (`search_graph`, `query_graph` with a Cypher subset, `trace_call_path`, etc.) over stdio.

## Commands

| Task | Command | Notes |
|---|---|---|
| Build | `npm run build` | `tsc -p tsconfig.build.json && node scripts/fix-extensions.mjs`. Output → `dist/`. The `fix-extensions` step rewrites import specifiers to add `.js` (required for Node ESM — `"type": "module"`). |
| Test (full) | `npm test` | `vitest run`. Covers `src/**/*.test.ts` + `tests/**/*.test.ts`. |
| Test (single) | `npx vitest run src/cypherEngine.test.ts` | Standard vitest CLI — pass a path/glob. **Run only touched-file tests during implementation;** full suite at commit time. |
| Typecheck | `npx tsc --noEmit -p tsconfig.build.json` | No named script — run directly. |
| Run the server | `node dist/index.js --root <path-to-project>` | stdio transport. `--root` sets the project to index (defaults to cwd). |

**No lint script or ESLint config is wired in this repo** as of v0.5.0 (the "300-line limit" mentioned in `src/passes/CLAUDE.md` is a convention, not an enforced gate here). Don't invoke a `lint` script — it doesn't exist.

**Critical rebuild rule:** the MCP server runs the compiled `dist/index.js`, NOT `src/`. Any source change requires `npm run build` **and a Claude Code restart** before the running server reflects it. This is the single most common workflow mistake — the HANDOFF calls it out as step 1 after every wave ship.

## Key Files

| Path | Role |
|---|---|
| `src/index.ts` | Entry point — CLI arg parse + MCP server bootstrap. |
| `src/serverBootstrap.ts` | Builds context, DB path, registers graph tools. |
| `src/mcpToolHandlers.ts` + `mcpToolHandler*.ts` | MCP tool surface (schemas + handlers). |
| `src/cypherEngine.ts` (+ `Parser`, `SqlHelpers`, `Varpath`, `Support`, `NewFeatures`) | Cypher-subset → SQLite SQL translator. Not a real graph DB. |
| `src/graphControllerCompat*.ts` | System1→System2 compat shim — all graph reads route through here, not the DB directly. |
| `src/indexingPipeline*.ts` + `src/passes/*` | 7-pass indexer (tree-sitter + ts-morph enrichment). Runs in a worker thread. |
| `src/graphDatabase*.ts` | SQLite property-graph store + helpers + migrations. |
| `tsconfig.build.json` | Build config (NOT `tsconfig.json` — that's for editor/ts-morph). |

## Folder Map

- `src/` — all source; tests colocated as `<module>.test.ts`.
- `src/passes/` — indexing enrichment passes (+ `src/passes/CLAUDE.md`, the canonical pass-behavior reference).
- `src/__fixtures__/` — shared parser test fixtures.
- `tests/` — integration/acceptance tests + `acceptance-fixture/` (a real mini-repo indexed end-to-end).
- `dist/` — build output (what the server actually runs).
- `roadmap/` — wave process: `HANDOFF.md`, `wave-N-*.md`, `decisions/`, `follow-ups/`, `_archived/`.
- `.claude/vendor-gotchas/` — per-vendor gotcha files (currently `ts-morph.md`).

## Gotchas / Environment Quirks

- **dist-vs-src.** See the Critical rebuild rule above. The most common mistake.
- **Edge-type semantics.** `CALLS` = sync call; `ASYNC_CALLS` = awaited/Promise-returning call. Call-graph queries (dead-code, fan-in/out) must union both: `NOT ()-[:CALLS|ASYNC_CALLS]->(n)`. Single-type `[:CALLS]` false-flags async-only-called functions as dead (fixed Wave 3 / v0.5.0).
- **`MAX_ROWS = 200`** (`cypherEngineSupport.ts`). Default page size, not a hard ceiling. Queries without `LIMIT` cap at 200 and return `truncated: true`. The `query_graph` `limit`/`offset` args bypass the cap for explicit pagination.
- **ts-morph two-tier resolution.** tree-sitter is the always-on fast path (~95% of edges); the ts-morph enrichment pass (Pass 6) is opt-in precision that supersedes tree-sitter edges at 0.98 confidence on hard cases (barrels, overloads, interface dispatch). Don't assume tree-sitter edges are final on TS/TSX. Full ts-morph gotchas: `.claude/vendor-gotchas/ts-morph.md` (bundled TS version, `refreshFromFileSystem()` invalidation, Windows path slashes, worker memory ceiling).
- **`skipTsEnrichment`.** Operational escape valve threaded through indexing options — disables Pass 6/7 on resource-constrained environments. (NOTE: not yet exposed on the `launch-diff` path — open follow-up.)
- **Parse anomalies.** `parseAnomalies` (genuine tree-sitter ERROR/MISSING) is expected ~0; `filesWithoutSymbols` (clean parse, no defs) is tolerated. New test fixtures building a `ParsedFileResult` must include the anomaly fields (Wave 3).
- **Node ≥ 20** (`engines`). SQLite via `better-sqlite3` — vitest uses `pool: 'forks'` (not threads; not thread-safe). Tests must import `describe`/`it`/`expect` from `'vitest'` (no globals).

## Known Tech Debt

- **Server version literal is manual.** `src/index.ts` hardcodes the `McpServer` constructor `version` (the SDK does not auto-read `package.json`). Synced to `0.6.0` at the v0.6.0 release. Cosmetic (MCP metadata only), but re-sync both at every release.
- **No lint/typecheck scripts.** Neither is a named `package.json` script (see Commands). Intentional for now; don't "helpfully" add a `lint` script without an ESLint config to back it.

## Meta / Process

- **Wave process.** This repo uses the full wave process — see `~/.claude/notes/wave-process.md` for structural rules + Test-shape doctrine. Active state lives in `roadmap/HANDOFF.md` (read it at session start). Durable decisions in `roadmap/decisions/` (notably `two-tier-resolution-model.md`, `edge-supersession-model.md`).
- **Workflow pipeline opt-in (standing, user-authored).** The `run-phase` and `wrap-wave` Workflows are the opt-in default for this repo's wave execution and wrap (per `~/.claude/rules/agent-catalog.md` § Opt-in wiring). **`verify-wave` is NOT auto-run** — it stays manual-invoke only, aligning with meta M-48's global demote. (The engine *does* support it here: the dead-export scan was runtime-validated 2026-06-02, returning 185 candidates under the row cap. But the output is dominated by test helpers/entrypoints, so it's not worth auto-running. Invoke manually if you want a dead-export pass.)
- **Codebase graph.** This repo is self-indexed (~2450 nodes, ~4550 edges; 573 functions + 307 methods). Use the `codebase_graph` MCP tools for navigation/blast-radius over manual grep where available.

## What CLAUDE.md Does Not Cover

- Indexing pass behavior in detail → `src/passes/CLAUDE.md`.
- ts-morph vendor gotchas → `.claude/vendor-gotchas/ts-morph.md`.
- Architecture decisions + rationale → `roadmap/decisions/`.

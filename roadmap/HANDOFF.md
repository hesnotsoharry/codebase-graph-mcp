# HANDOFF — codebase-graph-mcp

> Sticky-note orientation for the next session. Repo uses SemVer + Keep-a-Changelog; `roadmap/` (this dir) is the planning/agent surface. Currently at **v0.3.0** (2026-06-01).

## Where we are
- **v0.3.0 shipped** today — **Wave 1 (Wiring & Query Precision)**. Commits `1470e27` (P0) · `1efd088` (P1) · `8bb6d4f` (P2) · release `16e5383`; tag `v0.3.0`; pushed to `origin/main`. **CI matrix (Node 20+22 × ubuntu+windows) was triggered on the push — confirm it went green.**
- Wave 1 made the graph's wiring checks actually verify wiring, in three in-tree phases (no new deps):
  - `resolution_method` provenance on every resolution-pass edge.
  - Real HTTP URL+method extraction & path/verb route matching; multi-route fan-out removed (single best-match). **Behavior change:** fewer / more-accurate `HTTP_CALLS` edges on reindex.
  - Cypher `WITH` passthrough, negated-existence (`WHERE NOT ()-[:T]->(n)`) for dead-export queries, and `query_graph` `limit`/`offset` pagination with a `truncated` flag (no more silent 200-row cap).
- Full suite **831 green**. Wave file collapsed to a stub (`roadmap/wave-1-wiring-query-precision.md`); the full plan is in git at `57d9269`.

## What's next
- **`roadmap/wave-2-type-aware-resolution.md`** → ships as **0.4.0**, adds `ts-morph`. **Phase 0 is a GO/NO-GO spike** — do not build Phases 1-4 until it clears (cold-start < ~15s, ≥ 80% resolution coverage, demonstrable barrel/overload win). Depends on Wave 1's `resolution_method` provenance — `compiler_api` is the reserved value (see `roadmap/decisions/resolution-method-provenance.md`). Gated behind a mandatory `skipTsEnrichment` flag (one dev box can't tolerate the CPU load).
- Wave 1 minor follow-ups (low priority, all documented in CHANGELOG known-limitations): `WITH` is alias-passthrough not true projection; varpath queries silently skip `NOT EXISTS`; CTE `OFFSET` has no cross-page ordering guarantee without `ORDER BY`. Open follow-up filed: `roadmap/follow-ups/2026-06-01-heuristic-http-edges-false-positive-rate.md` (watch item).

## Key context / gotchas
- **Gate commands:** typecheck+build = `npm run build` (`tsc && node scripts/fix-extensions.mjs`); tests = `npm run test` (**Vitest**); **no linter configured** — no lint gate. CI matrix: Node 20+22 × ubuntu+windows.
- **`codebase_graph` MCP server** — was NOT attached during the Wave 1 session (graph-backed checks ran degraded/deferred; gate confidence rested on build + full Vitest suite, 831 green, + per-phase reviews). **Now registered** at user scope (`~/.claude.json`) as `node "C:\Web App\codebase-graph-mcp\dist\index.js"` — it attaches on session start, so this session and onward have `mcp__codebase_graph__*`. First graph query triggers a lazy auto-index of the session's cwd. Re-run `verify-wave` for a clean dead-export pass. (Registered against the local repo build, not npm — the package isn't published; `npm run build` + restart to update.)
- **Storage = SQLite + a hand-rolled Cypher-subset engine** (not Neo4j/Kuzu). Do NOT migrate the backend — researched and rejected; bottleneck is resolution precision + Cypher feature surface, not storage. (Kuzu was Apple-acquired/archived Oct 2025 — do not adopt.)
- **Resolution is purely syntactic today** (tree-sitter, no type checker) — Wave 2 adds the type-aware tier. CALLS edges carry calibrated confidence (0.65–0.95); `insertEdge` is `INSERT OR REPLACE` (last write wins).

## Pointers
- Plan: `roadmap/wave-2-type-aware-resolution.md` (next) · `roadmap/wave-1-wiring-query-precision.md` (shipped stub)
- Decisions: `roadmap/decisions/resolution-method-provenance.md`
- Pipeline: `src/indexingPipeline.ts` (8-pass orchestrator), `src/passes/` (+ `passes/CLAUDE.md`), `src/passes/httpLinkPass.ts`, `src/cypherEngineNewFeatures.ts`, `src/cypherEngineParser.ts`.

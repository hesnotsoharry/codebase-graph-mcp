---
project: codebase-graph-mcp
updated: 2026-06-02
---

## Current state
- Branch: main · Tag: v0.6.0 · Status: between waves (Wave 4 shipped 2026-06-02)
- Wave 4 = edge-type query hygiene + launch-diff enrichment skip (3 phases, all reviewed & shipped)

## Next 3 steps
1. **Restart Claude Code sessions** to pick up the v0.6.0 dist build — the MCP server runs `dist/index.js`; `search_graph` union relationship types + `skipTsEnrichment` are only live after rebuild+restart (done this wave).
2. **3 open follow-ups** (`follow-ups/`): `parameterize-remaining-edge-type-sql-builders` (3 inline edge-type SQL sites left out of Wave 4 scope — `graphDatabaseTraversal.ts:30` is RAW-interpolated, highest priority); `python-precision-tier` (multi-wave); `heuristic-http-edges-false-positive` (monitoring, no trigger met).
3. **Meta follow-up (not this repo):** the global `codebase-memory-quality` skill still uses the old single-type dead-code query — should adopt `search_graph` union or `[:CALLS|ASYNC_CALLS]`. Handled outside this repo.

## Active work
- Open follow-ups: 3 · [inbox](follow-ups/). Resolved+archived this wave: `parameterize-edge-type-list-buildnotsexists` (Wave 4 P1), `launch-diff-skip-tsenrichment` (Wave 4 P3).
- Wave 4 shipped: (P1) `buildNotExistsSql` binds edge types as `?` params; (P2) `search_graph` degree filter accepts union relationship types (`"CALLS|ASYNC_CALLS"` / array), fixing async-only-called fns mis-counted as zero in-degree; (P3) `launch-diff` `skipTsEnrichment` skips ts-morph Pass 6/7. Backward-compatible. Full suite 883 passed / 3 skipped; tsc clean; dist rebuilt.

## Reference index
- Project conventions: [CLAUDE.md](../CLAUDE.md)
- Durable decisions: [decisions/](decisions/) — two-tier-resolution-model.md, edge-supersession-model.md
- Vendor-gotchas: [.claude/vendor-gotchas/ts-morph.md](../.claude/vendor-gotchas/ts-morph.md)
- Wave 4 touch-points: `src/cypherEngineSqlHelpers.ts` (buildNotExistsSql) · `src/graphDatabaseHelpers.ts` (buildDegreeExpr / normalizeRelationshipTypes) · `src/indexingWorker.ts` (handleLaunchDiff skipTsEnrichment)

# Wave 1 — Wiring & Query Precision  [SHIPPED]

- **Shipped:** v0.3.0 (2026-06-01) · commits `1470e27` (P0) · `1efd088` (P1) · `8bb6d4f` (P2) · release `16e5383` · tag `v0.3.0`
- **Full plan + locked decisions:** in git history at `57d9269` (this file pre-collapse).

## Result
Made the graph's wiring checks actually verify wiring, in three in-tree phases (no new deps):
- **P0 — `resolution_method` provenance.** Every resolution-pass edge records *how* it was resolved (enum in `graphDatabaseTypes.ts`; values per edge type). Foundation for weighting precise vs heuristic edges. Promoted to a durable decision (Wave 2 cites it).
- **P1 — real HTTP URL+method matching.** Parser captures the first string/template-literal arg + `fetch` options method (`ExtractedCall.firstArgValue`/`optionsMethod`); `httpLinkPass` matches the actual URL against routes by normalized path segments (`:param`/`{param}`/`${…}` wildcards) + method agreement. Single best-match edge replaces the ≥0.3 multi-route fan-out. Canonical orphan (`fetch('/api/v2/tasks')` vs `/api/tasks`) now detectable.
- **P2 — Cypher `WITH` / negated existence / pagination.** `WITH` alias passthrough; `WHERE NOT ()-[:T]->(n)` → correlated `NOT EXISTS` (makes dead-export queries expressible); `query_graph` `limit`/`offset` + explicit `truncated` flag (kills silent 200-row truncation).

831 tests green. **Behavior change:** removing the HTTP fan-out drops some previously-emitted (false) `HTTP_CALLS` edges — fewer / more-accurate edges on reindex.

## Mechanical review (Stage 5)
Build green; full Vitest suite green (831 tests, 3 pre-existing skips). Per-phase reviewers: P0 n/a · P1 PASS · P2 FLAG→addressed. Graph dead-export scan **DEFERRED** — `codebase_graph` MCP server not attached this session (environment gap, not a defect); new exports are exercised end-to-end by the new suites.

## Follow-ups / known limitations
- Filed: `roadmap/follow-ups/2026-06-01-heuristic-http-edges-false-positive-rate.md` (watch item — heuristic-fallback HTTP edge false-positive rate).
- Documented in CHANGELOG [0.3.0] known-limitations: `WITH` is alias-passthrough not true projection · varpath silently skips `NOT EXISTS` · CTE `OFFSET` needs explicit `ORDER BY` for stable paging.
- Durable decision promoted: `roadmap/decisions/resolution-method-provenance.md` (Decision 1 — cited by Wave 2).

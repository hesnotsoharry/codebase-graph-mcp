---
status: PLANNED
created: 2026-06-02
---

# Wave 4 — Edge-type query hygiene + launch-diff enrichment skip

## Plan

### Status

DRAFT · target v0.5.1 · drafted 2026-06-02.

### Goal

After this wave, the graph engine's SQL builders handle edge types uniformly and safely: `buildNotExistsSql` binds edge-type values as parameters instead of inlining them into the SQL string, and the `search_graph` degree filter accepts a union of relationship types (`"CALLS|ASYNC_CALLS"` or an array) the same way the Cypher engine's alternation already does — so a call-graph degree query no longer mis-counts a function reached only via an awaited call. Separately, the `launch-diff` path gains a `skipTsEnrichment` escape valve so a caller on a resource-constrained machine can run a diff index without the expensive ts-morph enrichment pass. No existing query result or default behavior changes.

### Scope

**In scope:**

- `src/cypherEngineSqlHelpers.ts` — `buildNotExistsSql`: replace inline edge-type literals (`'${sanitizeIdentifier(t)}'` in `type IN (...)`) with bound `?` parameters appended to the query's parameter list.
- `src/graphDatabaseHelpers.ts` — `buildDegreeExpr` / `addDegreeConditions`: accept multiple relationship types and emit `AND e.type IN (?, ?, …)` with bound params when >1 type is supplied; single-type continues to emit `= ?` (or a one-element `IN`).
- `src/mcpToolHandlers.ts` — `search_graph` tool schema: `relationship` accepts a pipe-delimited string or a string array (back-compatible: a bare single type still works).
- `src/graphDatabaseTypes.ts` — `NodeFilter.relationship` widened from `EdgeType` to `EdgeType | EdgeType[]` (or equivalent).
- `src/indexingWorkerTypes.ts` (or wherever `LaunchDiffRequest` is defined) — add optional `skipTsEnrichment?: boolean`.
- The `handleLaunchDiff` call site — thread `skipTsEnrichment` through to the indexing options so Pass 6 (ts-morph enrichment) and Pass 7 (references) are no-ops when set.
- Tests for each: parameterization regression (Phase 1), union degree-filter + single-type regression (Phase 2), skip-flag IPC contract (Phase 3).

**Out of scope:**

- Reverting `codebase-memory-quality` skill's query from `query_graph` back to `search_graph` union form — that's a downstream meta change (separate, optional, the skill already works).
- Python precision tier (`follow-ups/2026-06-02-python-precision-tier.md`) — deferred, multi-wave.
- HTTP-edge false-positive monitoring (`follow-ups/2026-06-01-heuristic-http-edges-false-positive-rate.md`) — no trigger met, left open.
- Lifting the `MAX_ROWS = 200` default — not needed; `limit` already bypasses it.

### Phases

| Phase | Topic | Implementer | Notes | Observation |
|---|---|---|---|---|
| 1 | Parameterize `buildNotExistsSql` edge-type literals | sonnet-implementer | Pyramid. Internal-only. SECURITY hygiene (SQL string-building) → reviewTier `single` (skip not permitted for risky-code). Brief: replace inline `'${sanitizeIdentifier(t)}'` literals in the `type IN (...)` clause with bound `?` params on the existing parameter list; behavior must be byte-identical. Reference the bind-param pattern already in `pushWhereParam`/`buildWhereRhs`. | Internal — no observation point — behavior-preserving SQL hardening; `query_graph` negated-existence results are identical before and after. |
| 2 | `search_graph` degree filter accepts union relationship types | sonnet-implementer | Honeycomb. Cross-boundary (MCP tool contract = product surface). reviewTier `single` (additive, back-compatible). Orchestrator authors a failing acceptance test before dispatch. Brief: widen `relationship` in schema + `NodeFilter`; `buildDegreeExpr`/`addDegreeConditions` emit `IN (?,…)` for multi-type using bound params (same hygiene as Phase 1); single-type path unchanged. Match the Cypher engine's `[:CALLS\|ASYNC_CALLS]` alternation surface. | In a live session, an agent calling `search_graph(relationship="CALLS\|ASYNC_CALLS", direction="inbound", max_degree=0)` sees a function reached only via `await` absent from the returned rows the user reads — it's no longer falsely listed as a zero-degree (dead-code) candidate. |
| 3 | `launch-diff` `skipTsEnrichment` escape valve | sonnet-implementer | Honeycomb. Cross-boundary (worker IPC message contract). reviewTier `single`. Orchestrator authors a failing acceptance test before dispatch. Brief: add optional `skipTsEnrichment?: boolean` to `LaunchDiffRequest`; thread through `handleLaunchDiff` to the indexing options so Pass 6/7 are no-ops when true; unset = current behavior. See `.claude/vendor-gotchas/ts-morph.md` for the enrichment-pass contract. | A `launch-diff` run with `skipTsEnrichment: true` completes without the ts-morph enrichment pass — visible in the server log lines for that run (no Pass 6 / Pass 7 entries). |

### Acceptance criteria

- [ ] `buildNotExistsSql` in `src/cypherEngineSqlHelpers.ts` emits no inline edge-type string literals — edge types appear only as `?` placeholders with values pushed to the bound parameter list.
- [ ] All existing `cypherEngineNewFeatures.test.ts` / `cypherEngineRegression.test.ts` negated-existence + alternation tests pass unchanged.
- [ ] `NodeFilter.relationship` in `src/graphDatabaseTypes.ts` accepts a single `EdgeType` OR an array (type compiles; single-type callers unaffected).
- [ ] `search_graph(relationship="CALLS|ASYNC_CALLS", direction="inbound", max_degree=0)` returns only functions with zero inbound `CALLS` AND zero inbound `ASYNC_CALLS`; a function called solely via `await` is absent from the result.
- [ ] A single-type `search_graph(relationship="CALLS", …)` call returns the identical result it returns today (regression test green).
- [ ] `LaunchDiffRequest` has an optional `skipTsEnrichment?: boolean`; `handleLaunchDiff` threads it to indexing options.
- [ ] A `launch-diff` with `skipTsEnrichment: true` runs neither Pass 6 (ts-morph enrichment) nor Pass 7 (references); the default (unset) path runs both unchanged.
- [ ] `npx tsc --noEmit -p tsconfig.build.json` exits 0; touched-file vitest suites pass; full suite green at wrap.

### Files the next agent should read first

1. The `## Locked decisions` section of this wave file — verify decisions are filled before starting.
2. `src/cypherEngineSqlHelpers.ts` — `buildNotExistsSql` (Phase 1 target) + `pushWhereParam`/`buildWhereRhs` (the bind-param pattern to reuse).
3. `src/graphDatabaseHelpers.ts` — `buildDegreeExpr` / `addDegreeConditions` (Phase 2 target).
4. `src/mcpToolHandlers.ts` — the `search_graph` tool schema (Phase 2).
5. `src/graphDatabaseTypes.ts` — `NodeFilter` type (Phase 2).
6. `src/indexingWorkerTypes.ts` + the `handleLaunchDiff` handler — `LaunchDiffRequest` shape + call site (Phase 3).
7. `src/cypherEngineNewFeatures.test.ts` (~line 543) — the canonical `[:CALLS|ASYNC_CALLS]` alternation test shape to mirror.
8. `roadmap/follow-ups/2026-06-02-parameterize-edge-type-list-buildnotsexists.md` + `2026-06-02-launch-diff-skip-tsenrichment.md` — full intent for Phases 1 and 3.
9. `.claude/vendor-gotchas/ts-morph.md` — the enrichment-pass contract (Phase 3).

### Note to the implementer

The spirit of this wave is **hygiene + parity, not new behavior.** Phases 1 and 2 share one theme — edge types should be bound parameters, never inlined SQL — applied to two distinct builders (`buildNotExistsSql` and `buildDegreeExpr`); don't merge them or "improve" the other builder while you're in one. Phase 3 is unrelated (a perf escape valve on the diff path). The union-relationship surface must mirror the Cypher engine's existing `[:CALLS|ASYNC_CALLS]` form — don't invent a different separator. Keep every default path byte-identical: a single-type `search_graph`, an unset `skipTsEnrichment`, and existing negated-existence queries must behave exactly as they do today. Resist widening scope into the `MAX_ROWS` cap or the Python tier — both are explicitly out of scope. First step: verify the `## Locked decisions` section has decisions filled in.

Before declaring a phase complete, restate the observation point from the Phases table Observation column in your own words and describe what you actually observed there. If you could not observe it directly — no live IDE, no triggered chat session, no rendered panel — say so explicitly. Do not substitute "tests pass" for runtime observation. Tests passing at the unit boundary is necessary but not sufficient.

## Locked decisions

<!-- ADR entries are appended here as the wave progresses. Each entry: Context (1 line), Pick, Consequences, Enforcement.
Add `durable: candidate` flag if author thinks this decision has cross-wave reach.
Full best-practice-spectrum framing ONLY when 3+ axes are in genuine tension. -->

**Decision 0 (planner pre-lock, resolved from grounding — not a cell-gated ADR):** The `search_graph` union surface accepts BOTH a pipe-delimited string (`"CALLS|ASYNC_CALLS"`, primary — mirrors the Cypher engine's `[:CALLS|ASYNC_CALLS]` alternation) AND a string array, back-compatible with a bare single type. **Rationale:** parity with the existing alternation surface is the lowest-surprise choice; accepting an array too is a zero-cost ergonomic add. **Enforcement:** advisory-only (acceptance test in Phase 2 asserts both forms). This is a trivially-resolvable additive contract shape, so it bypasses the decision-review cell per `best-practice-spectrum.md` (no `sonnet-architect` dispatch needed). If a non-trivial decision arises mid-wave, it runs the cell before being appended here.

## Status

| Phase | Dispatched | Completed | Commit SHA | Observation point hit |
|---|---|---|---|---|
| 1 | 2026-06-02 | 2026-06-02 | 1a1816a | Internal — no observation point (behavior-preserving; tsc clean, 86 touched tests green) |
| 2 | 2026-06-02 | 2026-06-02 | (this commit) | Oracle (8b09665) green: search_graph union excludes async-only-called fns; single-type regression intact. tsc clean, 110 touched tests pass. Review FLAG (type-ergonomics) fixed inline. |

## Follow-up candidates

<!-- DEFAULT: empty. -->

## Result

<!-- Filled at ship by wrap team. -->

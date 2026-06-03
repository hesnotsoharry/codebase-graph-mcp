---
status: PLANNED
created: 2026-06-02
---

# Wave 3: cypher-negated-existence-correctness

## Plan

### Status

PLANNED · target v0.5.0 · drafted 2026-06-02

### Goal

After this wave, a negated-existence Cypher query can negate over **multiple edge types at once** — `WHERE NOT ()-[:CALLS|ASYNC_CALLS]->(n)` — so a dead-code query no longer mis-flags a function that is reachable only through an async call. Today the negated-existence subquery filters a single edge type (`AND type = 'CALLS'`), so any function called exclusively via `ASYNC_CALLS` appears uncalled and is reported dead. This is a false-positive in the product's advertised dead-code / unused-function capability (the `codebase-memory-quality` skill leans on raw `query_graph` Cypher; there is no dedicated dead-code tool). Additionally, variable-length-path (varpath) queries currently **silently discard** negated-existence WHERE clauses (`cypherEngineVarpath.ts` `continue`s past them), returning wrong results with no signal — after this wave that path fails loud with an explicit "unsupported in variable-length paths" error instead of silently lying.

### Scope

**In scope:**

- `src/.../cypherEngineParser.ts` — extend the four negated-existence forms (`parseNegatedExistence`, ~:255–317) to capture edge-type **alternation** (`[:T1|T2|...]`) instead of a single `(\w+)` token.
- `src/.../cypherEngineSqlHelpers.ts` — `buildNotExistsSql` (~:103–109): emit `AND type IN ('T1','T2', …)` (sanitized per type) instead of single `AND type = '<edgeType>'`. Single-type queries must still emit identical-behavior SQL (one-element IN, or preserve `=`).
- `src/.../cypherEngineVarpath.ts` (~:41, :68) — replace the two silent `continue`s past negated-existence conditions with an explicit thrown error matching the engine's existing error-surfacing convention.
- `test/.../cypherEngineNewFeatures.test.ts` — new cases: (a) `NOT ()-[:CALLS|ASYNC_CALLS]->(n)` does NOT flag an async-only-called function as dead; (b) single-type negated query behavior unchanged (regression guard); (c) varpath + NOT clause throws the explicit error.

**Out of scope:**

- Implementing actual NOT-support inside varpath queries — deferred via explicit-error (see Locked Decision 1); revisit only if a real varpath-NOT use case appears (file a follow-up candidate then).
- A dedicated `find_dead_code` MCP tool — deferred; tracked by `roadmap/follow-ups/2026-06-02-verify-wave-dead-export-engine-support.md` (this wave resolves that follow-up's only live blocker; the dedicated-tool idea remains open there).
- Edge-type alternation for **positive** edge matches (non-negated `MATCH (a)-[:T1|T2]->(b)`) — see Locked Decision 2; scoped to negated-existence only this wave unless trivially free to extend (implementer's call, recorded as a decision if extended).
- Pagination / 200-row cap work — verified NON-blocking (external `limit` option bypasses `MAX_ROWS`; `cypherEngine.ts:156–157`).

### Phases

| Phase | Topic | Implementer | Notes | Observation |
|---|---|---|---|---|
| 1 | Edge-type alternation in negated-existence | `sonnet-implementer` | Pyramid (pure parser/SQL logic) · internal-only · Extend `parseNegatedExistence` regex to capture `T1\|T2\|…`, thread a `string[]` edgeType through the `NegatedExistenceCondition`, and emit `type IN (...)` in `buildNotExistsSql`. Preserve single-type behavior exactly (regression). `reviewTier: single`. Orchestrator authors the failing acceptance test (async-only-called function) BEFORE dispatch. | Agent issuing `query_graph` with `WHERE NOT ()-[:CALLS\|ASYNC_CALLS]->(n)` against a graph where a function is called only via ASYNC_CALLS gets a result set that **excludes** that function. Observable through the `query_graph` MCP tool after rebuild + server restart. |
| 2 | Varpath silent NOT-drop → explicit error | `sonnet-implementer` | Pyramid · internal-only · Replace the two `continue` statements at `cypherEngineVarpath.ts:41,68` with a thrown error matching the engine's existing error convention (locate how parse/exec errors are surfaced to `query_graph`). Message names the limitation: negated-existence unsupported in variable-length paths. `reviewTier: single`. | Agent issuing a varpath query (`-[:X*1..3]->`) that carries a `NOT (...)` WHERE clause gets an explicit error response from `query_graph` instead of a silently-wrong result set. Observable through the `query_graph` MCP tool error path after rebuild + restart. |

### Acceptance criteria

- [ ] `WHERE NOT ()-[:CALLS|ASYNC_CALLS]->(n)` parses without error and produces SQL containing `type IN ('CALLS','ASYNC_CALLS')` (verified via test/snapshot).
- [ ] A function with only an inbound `ASYNC_CALLS` edge (no `CALLS`) is NOT returned by a `NOT ()-[:CALLS|ASYNC_CALLS]->(n)` dead-code query — and IS returned by the old single-type `NOT ()-[:CALLS]->(n)` query (proves the fix closes the false-positive).
- [ ] Existing single-type negated-existence queries (`NOT ()-[:CALLS]->(n)`) produce unchanged results — all four directional forms regression-guarded.
- [ ] A varpath query carrying a negated-existence WHERE clause throws an explicit, message-bearing error (no silent drop); the error reaches the `query_graph` caller.
- [ ] Full suite green (855+ passing, prior baseline), lint + typecheck + formatter clean.

### Files the next agent should read first

1. `src/.../cypherEngineParser.ts` — `parseNegatedExistence` (~:255–317), the four directional regexes; this is where alternation is captured.
2. `src/.../cypherEngineSqlHelpers.ts` — `buildNotExistsSql` (~:103–109), the `AND type = '<edgeType>'` emission to change to `IN (...)`.
3. `src/.../cypherEngineVarpath.ts` — the two `continue` sites (~:41, :68) that silently drop NOT clauses.
4. `test/.../cypherEngineNewFeatures.test.ts` — existing negated-existence integration tests (~:457–485) + pagination tests (~:538–542); extend here, match the seeding pattern.
5. `src/.../graphDatabaseTypes.ts` — edge-type enum (`CALLS`, `ASYNC_CALLS` at ~:31,63) confirming both types are real.

### Note to the implementer

The spirit of this wave: a dead-code query that lies is worse than no dead-code query. FIX 1 makes the query *correct* (negate over all call-edge types together); FIX 2 makes the engine *honest* (error instead of silently dropping a clause it can't handle). Temptation to resist: over-building. Do NOT implement full NOT-support inside varpath — the goal needs the single-match shape only; fail loud and stop (Locked Decision 1). Do NOT silently broaden positive-match alternation unless it's genuinely free (Locked Decision 2 — if you extend it, record a decision). Keep single-edge-type behavior byte-identical — that's the regression risk. First step: verify the `## Locked decisions` section below has decisions filled in (it does — 2 locked).

Before declaring a phase complete, restate the observation point from the Phases table Observation column in your own words and describe what you actually observed there. If you could not observe it directly — no live IDE, no triggered chat session, no rendered panel — say so explicitly. Do not substitute "tests pass" for runtime observation. Tests passing at the unit boundary is necessary but not sufficient. (Note: both observation points require an MCP server rebuild + restart to exercise live; if you cannot restart the server in-session, say so and rest on the integration tests at the `query_graph` execution boundary — `engine.execute(...)` — not the parser unit boundary.)

## Locked decisions

## Decision 1: Varpath negated-existence — explicit error vs. implement support

**Context:** Varpath queries silently drop `NOT (...)` WHERE clauses (`cypherEngineVarpath.ts:41,68`), returning wrong results with no signal. Fix path: implement NOT-support in varpath, or fail loud.
**Pick:** Throw an explicit "negated-existence not supported in variable-length paths" error at the two drop sites.
**Rationale:** The wave's dead-code goal uses the single-match query shape, not varpath — so varpath-NOT support is unused scope. The actual defect is the *silence*; fail-loud (error > silently-wrong) is the correct minimal fix and prevents a whole class of invisible wrong answers. Implementing varpath-NOT is real work with no current consumer.
**Consequences:** A varpath query with a NOT clause now errors instead of returning wrong data; if a real varpath-NOT use case appears later, it must be implemented deliberately (file a follow-up).
**Enforcement:** `none (convention)` — enforced by the thrown error in `cypherEngineVarpath.ts` itself + a regression test asserting the throw; no hook/gate.
> Review tier: skip (trivial — clear best-practice answer, no multi-axis tension; the wave goal does not require varpath-NOT). Recorded without the decision-review cell per the skip-tier path.

## Decision 2: Alternation scope — negated-existence only vs. all edge matches

**Context:** Edge-type alternation `[:T1|T2]` is being added to negated-existence parsing. The single-edge-type token is the parser's general shape, so positive matches (`MATCH (a)-[:T1|T2]->(b)`) could also gain alternation.
**Pick:** Scope alternation to negated-existence parsing for this wave; extend to positive matches ONLY if it falls out for free from the parser change.
**Rationale:** The dead-code correctness goal needs alternation only in the negated form. Broadening to positive matches risks regressions in the positive-match SQL path that this wave hasn't budgeted test coverage for. If the parser refactor naturally covers both, taking it is fine — but it must be a deliberate, tested choice, not an accident.
**Consequences:** Positive-match alternation may remain unsupported after this wave; if so, that's a clean future follow-up, not a regression.
**Enforcement:** `advisory-only` — guidance to the implementer; the reviewer cell (`reviewTier: single`, Phase 1) checks scope adherence.
> Review tier: skip (trivial scoping call, no tension).

## Status

| Phase | Dispatched | Completed | Commit SHA | Observation point hit |
|---|---|---|---|---|
| 1 | 2026-06-02 (run-phase wf_a1eeda15-8b5) | 2026-06-02 | c24f03b | Integration-only (no live MCP restart) — `engine.execute` boundary tests green; `query_graph` runtime not exercised |
| 2 | — | — | — | — |

## Follow-up candidates

<!-- DEFAULT empty. Stage here only if Tier-3 AND-gate clears. -->

## Result

<!-- filled at ship by wrap team -->

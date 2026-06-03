---
status: RESOLVED
created: 2026-06-02
resolved: 2026-06-03
qualifying-criterion: multi-file (3 SQL builders + test snapshots)
cannot-be-cleared-by: single-sonnet-implementer-dispatch (requires cross-builder audit + coordinated refactoring)
---

## Resolution (2026-06-03)

All three edge-type SQL builders parameterized; adversarial review (attack-diff) cleared after two follow-up fixes. Delivered:

- **`buildOptionalHopJoin`** (cypherEngineNewFeatures.ts) — gained a `params: unknown[]` accumulator arg; emits `?`, both call sites (singleNodeSql, singleHopSql) updated to merge optJoin params in SQL-document order.
- **`varpathSql`** (cypherEngine.ts) — edge type bound as `?`; additionally fixed a **pre-existing** end-hop param-ordering bug (endParams were transposed relative to maxHops/minHops) discovered during the change, now covered by a dedicated endpoint-WHERE test.
- **`runBfsTraversal`** (graphDatabaseTraversal.ts, the unsanitized highest-priority site) — edge types bound via `?` placeholders spread into `.all()` at the correct recursive-CTE position; `minConfidence` also parameterized (was a raw numeric interpolation of MCP-sourced input) under a single `applyConfidence` boolean that gates clause + param together (drift-immune).
- **Audit:** exhaustive grep confirmed no other edge-type inline-literal sites remain.
- **Tests:** new `graphDatabaseTraversal.test.ts` (BFS exact-set + injection-safety + minConfidence filter); extended varpath + buildOptionalHopJoin coverage with negative-literal guards. Full suite 898 passed / 3 skipped; typecheck + build clean.

Out of scope / not done: nothing outstanding. (`confidenceClause` numeric interpolation — originally noted as out-of-threat-model — was parameterized anyway for defense-in-depth.)

# Parameterize remaining edge-type SQL builders (SQL injection hardening, Phase 2 follow-up)

## Context

Wave 4 Phases 1 and 2 parameterized two edge-type SQL builders:
- `buildNotExistsSql` (Phase 1) — parameterized `type IN (...)` clauses; inline literals replaced with bound parameters
- `buildDegreeExpr` / `addDegreeConditions` (Phase 2) — parameterized `type = ?` and `type IN (?,…)` clauses

However, three other edge-type SQL builders still inline type values without parameterization:
1. `cypherEngine.ts:299` — `type = '${sanitizeIdentifier(edgeType)}'`
2. `cypherEngineNewFeatures.ts:58` — same pattern
3. `graphDatabaseTraversal.ts:30` — `runBfsTraversal` with raw `'${t}'` interpolation (not even sanitized; highest priority)

All three follow the same unsafe pattern — inline string literals instead of bound parameters.

## Scope

1. **Refactor the 3 builders** to use parameterized SQL (matching the hygiene applied in Wave 4 P1/P2):
   - Replace inline `'${sanitizeIdentifier(edgeType)}'` literals with bound `?` placeholders
   - Append type values to the parameter list in order
   - Preserve single-type vs. multi-type branches if they exist

2. **Audit for additional inline-literal patterns** in the Cypher engine (grep `buildNot*Sql`, `buildMatch*Sql`, `runBfs*` for similar patterns)

3. **Update test snapshots and assertions** where the SQL string changes from inline to parameterized form

4. **Verify type contracts** — confirm parameter order and SQL shape match callers

## Acceptance

- All three builders emit parameterized SQL with edge types passed as bound parameters, not inline literals
- Grep audit confirms no other edge-type SQL sites remain with inline literals
- Test snapshots updated; all tests green; full suite passing
- Single-type and multi-type behavior regression-tested (results unchanged)

## Rationale for multi-file scope

Although a single implementer *could* theoretically scope this tightly to one builder + immediate test snapshots, the full value requires:
- Cross-builder consistency review (ensuring all three use the same parameterization pattern)
- Broader Cypher-engine audit (grep for related inline patterns beyond the three known sites)
- Coordinated snapshot updates (multiple test files affected)
- Security hygiene verification (ensuring no new injection vectors are created)

This makes it a solid candidate for a planned security-hardening or query-engine wave, rather than a single-dispatch task.

## Related work

- Wave 4 Phase 1: `buildNotExistsSql` parameterization (commit 1a1816a)
- Wave 4 Phase 2: `buildDegreeExpr` parameterization (commit b97375d)
- Wave 4 check-2 FLAG: identified 3 remaining sites; decision to defer for coordinated sweep

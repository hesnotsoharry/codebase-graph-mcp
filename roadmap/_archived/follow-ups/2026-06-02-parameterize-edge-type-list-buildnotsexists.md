---
status: OPEN
created: 2026-06-02
qualifying-criterion: multi-file (Cypher SQL emitter + SQL builder + test snapshot)
cannot-be-cleared-by: sonnet-implementer-dispatch
---

# Parameterize edge-type list in buildNotExistsSql (SQL injection hardening)

## Why this follow-up

Wave 3 Phase 1 extended `buildNotExistsSql` to emit `type IN ('CALLS','ASYNC_CALLS',...)` for multi-type negated-existence queries (previously single-type only, `type = 'CALLS'`). The implementation uses inline string literals with per-token sanitization (`sanitizeIdentifier(t)`), which is currently safe (captures `[\w|]+`, sanitizer strips pipes, no injection vector observable).

However, this widens the injection surface: each edge type in the alternation list becomes a sanitized-but-still-inline literal. This is a **pre-existing hardening opportunity** that Wave 3 made more visible. The fix scope spans the SQL-emission logic, test snapshots, and type-contract updates across the Cypher engine.

## Scope

1. **Refactor `buildNotExistsSql` to use parameterized SQL** — replace inline `'${sanitizeIdentifier(t)}'` literals with bound parameter placeholders (e.g. `$1, $2, ...` per the SQL builder's parameter-binding mechanism), or defer to a parameterized IN-list helper if one exists in the codebase.

2. **Audit related SQL builders** for the same pattern (grep `buildNot*Sql`, `buildMatch*Sql` for inline literals that should be bound).

3. **Update test snapshots** where the SQL assertion changes from inline to parameterized form.

4. **Verify type contract** — confirm `NegatedExistenceCondition` and its SQL consumers agree on the parameterization.

## Acceptance

- `buildNotExistsSql` emits parameterized SQL with edge types passed as bound parameters, not inline literals.
- All four negated-existence directional forms produce parameterized output.
- Single-type queries continue to work identically (regression guard).
- Full suite green; no logic change (hardening only).

## Note for next wave

This is **security-posture work, not a correctness fix**. No current injection vulnerability exists. A sonnet-implementer could theoretically handle this solo if they stay tightly scoped to `buildNotExistsSql` + immediate callers + test snapshots. However, the audit step (grep for related inline-literal patterns) benefits from a broader Cypher-engine review, making this a solid multi-file task for a planned wave rather than a single-dispatch fix. File as a candidate for the next security-hardening or query-engine pass.

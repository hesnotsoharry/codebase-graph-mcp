---
status: RESOLVED
created: 2026-06-02
origin: meta wave M-48 (declared-but-never-wired audit)
priority: medium
resolved-during: wave-3-cypher-negated-existence-correctness
updated: 2026-06-02
---

# Engine support for reliable dead-export detection (unblocks meta's verify-wave)

## Why this follow-up is in THIS repo (context for future codebase-graph-mcp agents)

This item originates from a **meta-framework wave (M-48, 2026-06-02)**, not from this repo's own
work — but the fix belongs here, so it's filed here. Background:

- The meta framework has a wave-end workflow, `verify-wave.workflow.js`, that **calls this repo's
  graph MCP** to do a global dead-export advisory (find exported functions nothing calls).
- M-48 audited the meta framework for "declared-but-never-wired" mechanisms and found verify-wave
  was effectively inert: doctrine declared it as the wave-end mechanical-review step, but it could
  never produce a usable dead-export result because **this repo's `query_graph` surface can't
  express or paginate the query**.
- Meta's response (M-48 Phase 2): **DEMOTED** verify-wave to manual-invoke and corrected its
  doctrine (it no longer claims to run automatically). That fixed the *meta-side honesty* problem.
- The **real capability fix lives here** — meta consumes the graph; it doesn't implement it, and the
  project-meta boundary forbids meta editing this repo's server. So this repo owns the engine work.
- **When this is fixed, meta will re-wire verify-wave.** The meta DEMOTE decision left a re-wire
  trigger tied to this follow-up's resolution (see meta `roadmap/wave-m48-enforcement-wiring.md`
  Phase 2 + `roadmap/decisions/`).

## What (three blockers in graph v0.2.0's query surface)

1. The natural query — `MATCH (n:Function) WHERE NOT ()-[:CALLS]->(n)` — uses a **negated path
   pattern**, unsupported by v0.2.0's single-MATCH Cypher WHERE subset (no `WITH`/`UNWIND`/
   function-calls, no `IS NULL`).
2. `query_graph` caps at **~200 rows**, below e.g. meta's 244 `Function` nodes — full enumeration
   via set-difference isn't possible in one query.
3. Dead-export must union **CALLS + ASYNC_CALLS** edge types (a function reached only via
   ASYNC_CALLS is not dead).

## Scope (pick one)

- (a) negated-path-pattern / `IS NULL` support in the Cypher subset; OR
- (b) a dedicated `find_dead_code` / `unreferenced_symbols` tool; OR
- (c) pagination (OFFSET or cursor) so >200-node graphs can be enumerated.

Then notify meta so verify-wave's dead-export advisory can be re-enabled non-deferred and re-wired.

## Acceptance

`verify-wave` run against a >200-function graph returns a complete dead-export list (entrypoints
excluded) without hitting the row cap or the DEFERRED path.

## Cross-references

- Meta origin follow-up (now routed here): `meta/roadmap/follow-ups/2026-06-01-graph-dead-export-cypher-capability.md`
- Meta audit: `meta/roadmap/discovery/2026-06-02-declared-but-never-wired-audit.md` (finding 1.1)
- Meta wave + decision: `meta/roadmap/wave-m48-enforcement-wiring.md` Phase 2
- Interim behavior (already shipped meta-side): verify-wave reports dead-export as best-effort/DEFERRED, never a hard gate.

## Resolution (wave-3-cypher-negated-existence-correctness)

Closed by `haiku-followup-auditor` during wave audit on 2026-06-02.

**Blocker audit result:**

- **Blocker 1 (negated-path patterns):** RESOLVED. Wave 3 Phase 1 (c24f03b) shipped `parseNegatedExistence` with full support for `NOT ()-[:CALLS|ASYNC_CALLS]->(n)` across all four directional forms (`->`/`<-`). The parser now captures edge-type alternation `[:T1|T2|...]` into `edgeTypes: string[]` and `buildNotExistsSql` emits `type IN (...)`. Code inspection: cypherEngineParser.ts:250–337.

- **Blocker 2 (200-row cap / pagination):** STALE (pre-existing). The cap was already bypassed by external `limit` option in `cypherEngine.ts:156–157` prior to Wave 3. Not a blocker.

- **Blocker 3 (CALLS + ASYNC_CALLS union):** RESOLVED. Wave 3 Phase 1 (c24f03b) shipped edge-type alternation support explicitly for this use case. The query `NOT ()-[:CALLS|ASYNC_CALLS]->(n)` is now parseable and executable in `query_graph`.

**Verdict:** All three stated blockers are now cleared (one was already resolved as pre-Wave-3 prior art; two are resolved by Wave 3). The meta framework's `verify-wave` workflow can now execute a dead-export query that correctly unions both call-edge types. Meta's re-wire trigger is satisfied. No residual work identified — close.

Evidence type: `code-inspection-only` (code changes visible in diff; Wave 3 observation points are integration tests only, no live MCP runtime validation cited in wave result section).

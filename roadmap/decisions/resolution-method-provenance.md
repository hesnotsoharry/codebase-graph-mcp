---
title: resolution_method edge provenance
decided-in: wave-1-wiring-query-precision
date: 2026-06-01
status: accepted
---

# `resolution_method` lives in edge `props`

**Context:** Agents and gate-checks need to know *how* an edge was resolved in order to weight verdicts — hard-fail on a broken *precise* edge, only warn on a *heuristic* one. Before Wave 1, confidence was on `CALLS` edges only and the resolution method was neither recorded nor queryable.

**Decision:** Every edge written by a resolution pass carries `props.resolution_method` — a string from the `ResolutionMethod` union exported by `graphDatabaseTypes.ts`. No schema migration: `props` is an existing JSON blob and `insertEdge` is `INSERT OR REPLACE` (`graphDatabaseHelpers.ts`), so same-triplet supersession already works.

**Values:**
- `import_resolved` · `same_file` · `name_unique` · `new_expression` — `CALLS` / `ASYNC_CALLS` (set per-branch in the call resolver)
- `typeof_regex` — `TYPEOF_REFERENCES`
- `url_literal` · `url_template` · `heuristic_name` — `HTTP_CALLS`
- `compiler_api` — **reserved for Wave 2** (ts-morph type-aware resolution tier)

**Consequences:** Every edge-write site must set it. Query/gate logic can filter by provenance (`WHERE e.resolution_method = '…'`). **Wave 2 depends on this decision** — `compiler_api` is the reserved provenance value for the type-aware tier that supersedes lower-confidence syntactic edges.

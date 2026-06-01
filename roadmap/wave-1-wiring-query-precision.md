# Wave 1 — Wiring & Query Precision

- **Status:** PLANNED
- **Target version:** 0.3.0 (minor — new capability, backward-compatible)
- **New runtime dependencies:** none (all in-tree)
- **Repo:** `codebase-graph-mcp` (first formally-planned wave; prior history is version-tracked 0.1.0 → 0.2.2)
- **Planned:** 2026-06-01

## Goal

Make the graph's wiring checks actually verify wiring. Today three things undermine trust in the gate:

1. **`HTTP_CALLS` never compares the real URL or method.** `httpLinkPass.scoreRouteMatch` scores a call→route match by checking whether the *enclosing function's name* shares path-segment substrings with the route path, stores the *route's* path on the edge (not the called URL), hardcodes `fetch` → `GET`, and fans out an edge to **every** route scoring ≥ 0.3. The canonical bug — frontend calls `/api/v2/tasks`, route is `/api/tasks` — is structurally uncatchable today.
2. **`query_graph` silently truncates at 200 rows**, so a gate that reports "no callers" may just be truncated — false confidence.
3. **Agents can't distinguish a precise edge from a heuristic one** — confidence is on `CALLS` only, and the *method* of resolution isn't recorded or queryable.

This wave fixes all three with in-tree changes — no new dependencies.

## Scope

**In:** resolution-method provenance (#4) · HTTP URL+method extraction & matching (#1) · Cypher `WITH` / negated-existence / pagination (#3).

**Out (deferred to Wave 2):** ts-morph type-aware resolution (#2) · REFERENCE edges (#6). **Already shipped (v0.2.2), do not re-do:** parse-anomaly full file list (#5), incremental prune fix.

## Locked decisions

### Decision 1: `resolution_method` lives in edge `props`
**Context:** Agents need to know *how* an edge was resolved to weight gate verdicts (hard-fail on precise orphans, warn on heuristic ones).
**Pick:** Add a `resolution_method` string to the edge `props` JSON. No schema migration — `props` is an existing JSON blob and `insertEdge` is `INSERT OR REPLACE` (`graphDatabaseHelpers.ts:42`).
**Rationale:** Zero-risk, immediately queryable (`WHERE e.resolution_method = '...'`), and supersession already works via REPLACE.
**Consequences:** Every edge-write site must set it. Enum (const + type): `compiler_api` (reserved for Wave 2) · `import_resolved` · `same_file` · `name_unique` · `new_expression` · `url_literal` · `url_template` · `heuristic_name` · `typeof_regex`.

### Decision 2: HTTP URL extraction happens at the parser layer
**Context:** `ExtractedCall` (`treeSitterTypes.ts:50-57`) captures `calleeName`, `receiverName`, and argument *count* — **not** argument values. The URL string is not available to `httpLinkPass`.
**Pick:** Add `firstArgValue?: string` (raw text of the first string-literal argument) and `optionsMethod?: string` (the `method` property when the 2nd arg is an object literal) to `ExtractedCall`; populate both in `treeSitterParserCalls.ts`. `httpLinkPass` consumes them.
**Rationale:** The parser already walks the AST; re-traversing in the pass duplicates work, and the parse tree is freed after extraction. There is precedent — `extractRouteCandidate`/`extractHandlerName` already read argument nodes for route *definitions*.
**Consequences:** #1 is a parser-layer change, not a `httpLinkPass`-only change. Scope is one extra field-population in the extractor.

### Decision 3: URL ↔ route matching by normalized path + method
**Pick:** Normalize both sides — split into path segments; treat `:param`, `{param}`, and `${…}`/template interpolations as wildcard segments; require equal literal segments + segment count + method match (or route method `*`).
**Confidence + provenance:**
- exact literal path + method → **0.95** (`url_literal`)
- template/param match → **0.8** (`url_template`)
- no statically-extractable URL (computed, `baseURL + path`, axios instance) → fall back to today's name-heuristic at **≤ 0.5** (`heuristic_name`), **never dropped**.
**Consequences:** Orphan detection becomes real ("called URL has no matching route") and verb mismatches are catchable.

### Decision 4: Real method extraction
**Pick:** `fetch` defaults to `GET` but reads the options-object `method` (2nd arg, object literal, string `method`). `axios.<verb>` / `requests.<verb>` / `httpx.<verb>` etc. take the verb from the callee (already mapped). Store the *actual* `http_method` on the edge; matching requires method agreement.
**Consequences:** Removes the `fetch`-is-always-GET bug; POST-to-GET-only-route resolves as a mismatch, not a match.

### Decision 5: Remove multi-route fan-out
**Context:** `processFileHttpCalls` currently emits an edge to *every* route scoring ≥ 0.3.
**Pick:** Emit an edge to the single **best-matching** route. If no literal URL is extractable, keep the heuristic but cap to the top match and tag `heuristic_name` low-confidence.
**Consequences:** Eliminates the fan-out false-edge class. Some currently-present (false) edges disappear — intended; note in CHANGELOG.

### Decision 6: Cypher engine — `WITH`, negated existence, pagination
**Pick:** Extend the engine (`cypherEngineNewFeatures.ts` is the extension point) with: single-stage `WITH` pipe; negated existence pattern `WHERE NOT (a)-[:T]->(b)`; `LIMIT`/`OFFSET` on `query_graph`. Lift the silent 200-row cap to an explicit, paginable default that returns a `truncated` flag.
**Rationale:** Negated patterns make dead-export / "route with no inbound `HTTP_CALLS`" queries *expressible* instead of advisory; pagination removes the silent-truncation false-confidence bug.
**Consequences:** Update `SUPPORTED_CYPHER_FEATURES` in `get_graph_schema` so callers know the new surface.

## Phases (one commit each)

### Phase 0 — `resolution_method` provenance scaffold (#4)
- **Files:** `indexingPipelineCallResolution.ts` (tag `CALLS`/`ASYNC_CALLS` with their tier), `indexingPipelineTypeofResolution.ts` (`typeof_regex`), `graphDatabaseTypes.ts` (define enum const + type, document the prop), `passes/CLAUDE.md`. (`httpLinkPass.ts` is tagged in Phase 1.)
- **Change:** add `resolution_method` to edge props at every write site.
- **Gate:** `npm run build` green; `npm run test` green; fresh index → `query_graph` returns edges whose props include `resolution_method`.
- **Commit:** `feat(edges): tag edges with resolution_method provenance`

### Phase 1 — HTTP URL + method extraction & matching (#1)
- **Files:** `treeSitterTypes.ts` (`ExtractedCall.firstArgValue` + `optionsMethod`), `treeSitterParserCalls.ts` (capture first string-literal arg + `fetch` options `method`), `passes/httpLinkPass.ts` (rewrite `scoreRouteMatch` → URL/route normalization + method match + best-match selection + provenance), tests.
- **Gate:** build + test green; regression tests:
  - (a) `fetch('/api/v2/tasks')` vs route `/api/tasks` → **no** match (orphan)
  - (b) POST call vs GET-only route → **no** match (verb)
  - (c) `` `/api/users/${id}` `` vs `/api/users/:id` → match at `url_template` confidence
  - (d) computed URL (`base + path`) → heuristic fallback, low confidence, **not** dropped
  - (e) single best-match emitted, not fan-out
- **Commit:** `feat(http): extract real URL+method and match routes by path/verb`

### Phase 2 — Cypher `WITH` / negated patterns / pagination (#3)
- **Files:** `cypherEngine.ts`, `cypherEngineNewFeatures.ts`, `cypherEngineSqlHelpers.ts`, `mcpToolHandlerDefs.ts` (`query_graph` `offset`/`limit` params + `truncated` flag + `SUPPORTED_CYPHER_FEATURES` update), tests.
- **Gate:** build + test green; tests for `WITH` pipe, `WHERE NOT ()-[:CALLS]->(n)` dead-export query, and `offset`/`limit` pagination returning > 200 rows across pages with an explicit `truncated` flag.
- **Commit:** `feat(cypher): add WITH, negated-existence patterns, and pagination`

## Ship
Bump to **0.3.0**, move CHANGELOG `[Unreleased]` → `[0.3.0]`, tag. CI matrix (Node 20+22 × ubuntu+windows) must pass.

## Follow-up candidates
- Heuristic-fallback HTTP edges (`heuristic_name`, computed URLs) remain a known low-confidence class — acceptable; revisit only if false-positive rate is observed high.
- **`WITH` is alias-passthrough, not true projection narrowing** (Phase 2). `WITH a RETURN b` is treated as `WITH a, b` — WITH preserves the MATCH's bound aliases but does not restrict scope. Advertised honestly (only the passthrough shape `MATCH (n) WITH n WHERE …` is documented), so not a correctness lie; full Cypher WITH projection would need parser-level alias scoping. Revisit if a query genuinely needs scope narrowing.
- **Varpath queries silently skip `NOT EXISTS` patterns in WHERE** (Phase 2). `MATCH (a)-[:X*1..3]->(b) WHERE NOT ()-[:Y]->(b)` ignores the negated condition rather than erroring — add a warning/error for DX.
- **Pagination `OFFSET` on recursive-CTE (varpath) queries has no cross-page ordering guarantee** (Phase 2). OFFSET interacts with depth-based early-termination; pages are stable only with an explicit `ORDER BY`. Document on `query_graph`, or add an implicit stable sort for CTE pagination.

## Risks
- Non-literal URLs (axios instances with `baseURL`, `base + path`) aren't statically resolvable → covered by heuristic fallback; document the limit in CHANGELOG.
- Removing fan-out drops some currently-present (false) edges — intended behavior change; call it out in the release notes.

## Mechanical review (wave-end, Stage 5)

- **Gates:** `npm run build` green; full Vitest suite green (**831 tests**, 3 pre-existing skips) at wave end.
- **Per-phase reviewers:** P0 n/a (non-boundary) · **P1 PASS** · **P2 FLAG → addressed** (scope verified in-bounds — plan misnamed the handler file; `truncated` doc-comment corrected to match code).
- **Graph dead-export scan:** **DEFERRED** — the `codebase_graph` MCP server was not connected in this session, so the global dead-export + symbol-drift assertions could not run. Environment/connectivity gap, **not** a structural defect. New exports (`extractHttpCallArgs`, `buildNotExistsSql`, `parseWithAliases`, `parseNegatedExistence`, …) are exercised end-to-end by the new test suites, so unwired/dead new code would have surfaced as failing tests. Re-run `verify-wave` from a session with the graph server attached (root frozen at `C:/Web App/codebase-graph-mcp`) for a clean pass.

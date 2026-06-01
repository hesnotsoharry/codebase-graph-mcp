# Wave 2 — Type-Aware Resolution

- **Status:** PLANNED — **Phase 0 is a go/no-go spike.** Do not build Phases 1-4 until the spike clears its acceptance bar.
- **Target version:** 0.4.0 (minor)
- **New dependency:** `ts-morph` (TypeScript Compiler API wrapper) — added at Phase 0 spike.
- **Depends on:** Wave 1 (uses the `resolution_method` provenance from Wave 1 Decision 1; `compiler_api` is the reserved value).
- **Planned:** 2026-06-01

## Goal

Add a **type-aware precision tier** so `CALLS`/`ASYNC_CALLS`/`TYPEOF_REFERENCES` edges resolve through the cases tree-sitter name-matching drops or mis-targets: re-exported symbols (barrel files), overloaded names across modules, interface/method dispatch, and generic instantiation. Then add first-class **REFERENCE edges** for blast-radius completeness (type-only refs, decorator/JSX uses that `CALLS` misses).

The high-level architecture decision — **two-tier**: keep tree-sitter as the always-on fast structural pass, add ts-morph as an *opt-in precision-upgrade* pass — is locked (see Decision 1). Phase 0 validates feasibility before committing to the build.

## Scope

**In:** ts-morph two-tier enrichment (#2) · REFERENCE edges (#6).
**Out:** storage-backend migration · GraphRAG/vector embeddings (both researched and rejected — the bottleneck is resolution precision + query surface, not storage; vector search is a different use case).

## Locked decisions (ts-morph integration ADR)

> Source: architecture pass against the live pipeline, 2026-06-01. ts-morph API confirmed via web docs (ctx7 was unreachable that session) — **re-verify `getSymbolAtLocation`/`getAliasedSymbol` surface during the Phase 0 spike** before coding Phase 2.

### D1: Two-tier model + pass placement
New pass `typescriptEnrichmentPass` inserted as **Pass 6**, immediately after `typeofResolutionPass` (Pass 5.5), inside `runCorePasses`, before `runEnrichmentPasses`. It runs *after* all tree-sitter edges are written so there are edges to supersede. **Input:** `CALLS`/`ASYNC_CALLS`/`TYPEOF_REFERENCES` edges with `confidence < 0.97`, plus call sites with no resolved edge. **TS/TSX only** — skips other files.

### D2: `Project` lifecycle — worker-local singleton, warm-updated
The ts-morph `Project` is created **once per worker-thread lifetime** (stored alongside `db`/`parser`/`pipeline` in `indexingWorker.ts`), not per run. Cold-start loads `tsconfig.json`. Incremental runs warm-update via `sourceFile.refreshFromFileSystem()` for changed files and `project.addSourceFileAtPath()` for new ones. Deleted files → `sourceFile.forget()` for memory hygiene.

### D3: Thread model + mandatory skip flag
Runs **inside the existing indexing worker thread** (no second worker — avoids IPC serialization of resolution results and double-dispose complexity). Gated behind **`skipTsEnrichment?: boolean`** on `IndexingOptions` **and** `IndexRequestOptions` (must cross the worker IPC boundary). **Operationally required:** one dev box cannot tolerate CPU-heavy work — the skip flag is the escape valve, set by the operator, not an architectural choice. When set, `getOrInitTsMorphProject` returns `null` and the pass is a no-op.

### D4: Graceful degradation — tree-sitter graph always intact
| Condition | Behavior |
|---|---|
| no `tsconfig.json` | return `null`, skip pass, no error (non-TS project expected) |
| `skipTsEnrichment: true` | no-op |
| ts-morph constructor throws | caught by `runChunkedPass` isolation; set `tsMorphProjectFailed = true`; **do not retry** on subsequent incremental runs |
| `getSymbolAtLocation`/`getTypeAtLocation` → undefined | per-site skip; no edge for that site |

### D5: Confidence ladder + wrong-target supersession (NEW db method)
`compiler_api` resolution = **0.98**, above all tree-sitter tiers. Same-triplet supersession is automatic via `INSERT OR REPLACE` (`graphDatabaseHelpers.ts:42`). **FLAG — the real subtlety:** when ts-morph resolves a call to a *different target* than tree-sitter did, the `(source_id, target_id, type)` triplet differs, so REPLACE won't remove the wrong edge. The pass must explicitly delete the superseded edge first → **new method `deleteOutboundEdgesOfType(sourceId, type)`** on `GraphDatabase`, **scoped to project-internal edges** (`WHERE project = ? AND source_id = ? AND type = ?`) so it doesn't nuke correct external-package edges.

### D6: Regex TYPEOF retained as the detection layer
`indexingPipelineTypeofResolution.ts` stays (runs Pass 5.5, detection); the ts-morph pass *upgrades* `TYPEOF_REFERENCES` edges (correct target, 0.98) but does **not** subsume the regex pass — the regex layer is the fast-path for non-TS projects and the base layer when `skipTsEnrichment` is set.

### D7: Incremental participation
Upgrade edges from **changed files only** (consistent with `callResolutionPass`). Cross-file incoming-edge staleness is a pre-existing incremental-model limitation — not solved here, cleared by full reindex; document in `passes/CLAUDE.md`. Wire `onFilePruned?(absolutePath)` callback into `ResolveIncrementalOpts` (mirrors the existing `deleteNodes` callback) → `tsMorphProject?.getSourceFile(path)?.forget()`.

## Phases (one commit each)

### Phase 0 — Spike (GO/NO-GO, no graph writes)
- **Do:** add `ts-morph` as a dev dependency; write `scripts/ts-morph-spike.ts` that loads the project via `tsconfig`, iterates call sites from a representative file, calls `getSymbolAtLocation`, measures cold-start time, logs resolution results.
- **Acceptance bar:** cold-start < ~15s on the dev box **AND** resolves ≥ 80% of the call sites `callResolutionPass` currently resolves **AND** demonstrably resolves at least one barrel-re-export / overload case that tree-sitter drops.
- **GATE:** if the bar isn't met → **STOP**, file a follow-up with the spike data, ship nothing from this wave. Do not start Phase 1.
- **Also verify:** ts-morph's bundled `typescript` version ≥ the repo's `typescript` (else newer TS syntax silently resolves to `any`).

### Phase 1 — Infrastructure (lifecycle + skip flag + db method)
- **Files:** `indexingPipelineTypes.ts` + `indexingWorkerTypes.ts` (`skipTsEnrichment`), `indexingWorker.ts` (`tsMorphProject` singleton + `getOrInitTsMorphProject` + `tsMorphProjectFailed` guard + dispose-path `forget`), `graphDatabase.ts` + `graphDatabaseHelpers.ts` (`deleteOutboundEdgesOfType`), `indexingPipelineIncremental.ts` (`onFilePruned` callback). **No pass logic yet.**
- **⚠ Coordination:** `indexingPipelineIncremental.ts` is the file a prior in-flight agent was editing — confirm its `[Unreleased]` work has landed before touching it.
- **Gate:** build + test green; no-op confirmed when `skipTsEnrichment: true`.
- **Commit:** `feat(enrich): ts-morph worker lifecycle + skip flag + edge-supersession db method`

### Phase 2 — Pass implementation (`CALLS`/`ASYNC_CALLS`)
- **Files:** `passes/typescriptEnrichmentPass.ts` (new), `indexingPipeline.ts` (wire as Pass 6), `passes/CLAUDE.md`.
- **Pattern:** async `refreshFromFileSystem()` pre-step (outside transaction) → chunked synchronous upgrade loop (inside transactions). **Do not hold AST node references across the refresh boundary** (refresh forgets all child nodes — re-navigate after). Delete-before-insert for wrong-target via `deleteOutboundEdgesOfType`.
- **Gate:** build + test green; pass is no-op under skip; a barrel-re-exported call resolves to the real definition at 0.98 / `compiler_api`.
- **Commit:** `feat(enrich): type-aware CALLS resolution via ts-morph`

### Phase 3 — TYPEOF upgrade + full incremental
- **Files:** `typescriptEnrichmentPass.ts` (extend to `TYPEOF_REFERENCES`), `indexingWorker.ts` / `indexingPipelineIncremental.ts` (`onFilePruned` → `forget()`, warm incremental path).
- **Gate:** incremental single-file edit yields compiler-confidence edges for that file only; deleted file's ts-morph source is forgotten.
- **Commit:** `feat(enrich): type-aware TYPEOF upgrade + incremental warm-update`

### Phase 4 — REFERENCE edges (#6)
- **Files:** new `passes/referencesPass.ts` (function-level granularity to bound edge-count growth); captures type-only references, decorator/JSX uses that `CALLS` misses.
- **Gate:** build + test green; edge-count growth within expected bound; a blast-radius query surfaces a type-only consumer that `CALLS` alone misses.
- **Commit:** `feat(edges): first-class REFERENCE edges for blast-radius completeness`

## Ship
Bump to **0.4.0**, CHANGELOG `[Unreleased]` → `[0.4.0]`, tag. CI matrix must pass.

## Risks (from the architecture pass)
- **`refreshFromFileSystem` stale-node trap** — all child AST nodes are forgotten after refresh; re-navigate from `SourceFile`, never cache nodes across the boundary.
- **ts-morph bundled TS version** vs the indexed project's TS — verify at install (Phase 0).
- **Worker memory ceiling** — a `Project` holds the full language-service heap (500MB–1GB on large repos), additive to the tree-sitter parser; `skipTsEnrichment` is the escape valve.
- **`deleteOutboundEdgesOfType` breadth** — must be project-scoped, not global, so it doesn't remove correct external-package edges.
- **Incremental partial-upgrade consistency** — edges from unchanged files into a changed file aren't re-resolved; documented limitation, cleared by full reindex.

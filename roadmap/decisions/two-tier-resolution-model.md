---
status: ACTIVE
decided-in: wave-2-type-aware-resolution
promoted-during: wave-2-type-aware-resolution
---

## Context

Tree-sitter's name-matching pass resolves ~95% of edges correctly but drops cases (re-exported symbols, overloaded names, interface dispatch) that require type-aware analysis. We need precision tiers without reinventing resolution on every reindex.

## Pick

**Two-tier architecture:** Keep tree-sitter as the always-on fast structural pass (Passes 1–5), add ts-morph as an *opt-in precision-upgrade* pass (Pass 6) that runs *after* tree-sitter edges are written.

Pass placement:
- `typescriptEnrichmentPass` inserted as **Pass 6**, immediately after `typeofResolutionPass` (Pass 5.5), inside `runCorePasses`, before `runEnrichmentPasses`.
- **Input:** `CALLS`/`ASYNC_CALLS`/`TYPEOF_REFERENCES` edges with `confidence < 0.97`, plus call sites with no resolved edge.
- **Coverage:** TS/TSX files only; skips other projects.

Lifecycle and skip flag:
- ts-morph `Project` created **once per worker-thread lifetime** (stored alongside `db`/`parser`/`pipeline` in `indexingWorker.ts`), not per run.
- **Gated behind `skipTsEnrichment?: boolean`** on both `IndexingOptions` and `IndexRequestOptions` (mandatory — one dev box cannot tolerate CPU-heavy work).
- Incremental runs warm-update via `sourceFile.refreshFromFileSystem()` for changed files and `project.addSourceFileAtPath()` for new ones.

## Rationale

Tree-sitter provides deterministic fast-path coverage; ts-morph provides surgical precision on hard cases. Opt-in flag protects resource-constrained environments. Placing the pass after tree-sitter ensures there are edges to supersede and keeps the pass side-effect-isolated.

## Consequences

- Future waves will build on ts-morph's 0.98 / `compiler_api` confidence tier.
- All `CALLS`/`ASYNC_CALLS`/`TYPEOF_REFERENCES` edges now participate in a two-pass model; code must not assume syntactic edges are final.
- The skip flag is operational escapevalve, not architectural tuning — must be honored at worker initialization.
- Worker memory ceiling grows (500MB–1GB on large repos for the ts-morph `Project` heap); stale-node traps require careful AST navigation post-refresh.

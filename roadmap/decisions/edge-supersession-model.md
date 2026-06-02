---
status: ACTIVE
decided-in: wave-2-type-aware-resolution
promoted-during: wave-2-type-aware-resolution
---

## Context

When ts-morph resolves a call to a *different target* than tree-sitter did, the old `(source_id, target_id, type)` triplet is stale. `INSERT OR REPLACE` handles same-target supersession automatically, but wrong-target edges need explicit deletion. We must do this safely without wiping correct external-package edges.

## Pick

**Authoritative-but-guarded supersession model:**

1. **Per-caller scope:** Delete only edges originating from the *same source file and edge type* via new db method `deleteOutboundEdgesOfType(projectId, sourceId, type)`, scoped to project-internal edges only (`WHERE project = ? AND source_id = ? AND type = ?`).

2. **Resolution phase:** For each caller+edge-type, resolve all the caller's call sites via ts-morph → set `R` (only targets that map to an indexed node, at 0.98/`compiler_api`).

3. **Conditional delete:** **If `R` is non-empty → delete old edges then insert `R`.** **If `R` is empty → SKIP the delete** (don't let a file ts-morph fails to load wipe good tree-sitter edges).

4. **Known limitation:** On a TS file where ts-morph resolves *some* call sites, the bulk delete drops tree-sitter edges for the unresolved sites. Acceptable given ~100% spike resolution rate and that compiler-unresolvable calls are low-value. Edges lack call-site identity, so per-call-site reconciliation is impossible — authoritative-rebuild is the cleanest correct model.

## Rationale

- The call-resolution pass writes `CALLS`/`ASYNC_CALLS` edges *only* when both source and target are indexed nodes (`indexingPipelineCallResolution.ts:223-225`), so there are NO edges to external/non-indexed targets. Bulk `deleteOutboundEdgesOfType` is therefore safe — it can only touch intra-project edges.
- Skipping delete when `R` is empty protects against precision-loss from a single unresolvable file poisoning an entire call chain.
- The triplet model (source_id, target_id, type) guarantees uniqueness; per-call-site identity is not available in the current schema.

## Consequences

- All future ts-morph edge writes must follow this algorithm to maintain correctness.
- Incremental updates from unchanged files into changed files aren't re-resolved; this is a pre-existing incremental-model limitation, cleared by full reindex.
- Failed ts-morph loads (no tsconfig, parse errors) are gracefully degraded — tree-sitter edges stand and a `tsMorphProjectFailed` flag prevents retry on incremental runs.

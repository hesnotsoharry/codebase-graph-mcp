---
title: Thread skipTsEnrichment flag through launch-diff IPC contract
status: OPEN
created: 2026-06-02
updated: 2026-06-02
qualifying-criterion: schema (crosses LaunchDiffRequest IPC contract)
cannot-be-cleared-by: single-sonnet-implementer-dispatch (no; this is a straightforward schema-add + threading task — single implementer clears it)
wave: wave-2-type-aware-resolution
priority: low
---

## Context

Wave 2 added `skipTsEnrichment?: boolean` as a skip-gate for the ts-morph enrichment pass (`indexingPipelineTypes.ts` + `indexingWorkerTypes.ts`). This flag is required to allow CPU-constrained environments to opt out of the heavy TypeScript Compiler API initialization, preventing startup hangs on large repos.

However, `handleLaunchDiff` calls `getOrInitTsMorphProject(projectRoot)` **without a skip flag**, because the `LaunchDiffRequest` IPC contract has no `skipTsEnrichment` field. A startup launch-diff reindex on a CPU-constrained box will therefore still initialize the ts-morph Project, defeating the skip-gate's purpose.

## Affected surfaces

- `LaunchDiffRequest` type definition (IPC contract boundary)
- `handleLaunchDiff` call site (passes `projectRoot` only; no skip flag)
- Caller of `handleLaunchDiff` (must thread `skipTsEnrichment` from the environment or request context)

## Fix shape

1. Add `skipTsEnrichment?: boolean` field to `LaunchDiffRequest` type (alongside existing fields like `projectRoot`, `incrementalState`)
2. Update `handleLaunchDiff` to extract this field and pass it to `getOrInitTsMorphProject`
3. Document the default behavior (false = enrichment enabled for backward compatibility)
4. Verify the skip-path at integration test level (launch-diff with `skipTsEnrichment: true` does not hang on startup)

## Related work

- Decision 3 in Wave 2 ADR: `skipTsEnrichment` as mandatory escape valve for CPU-heavy work
- Phase 1 commit: `feat(enrich): ts-morph worker lifecycle + skip flag + edge-supersession db method`
- Bounded scope: startup-only, affects incremental state refresh only

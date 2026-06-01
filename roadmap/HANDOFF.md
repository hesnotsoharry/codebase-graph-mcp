# HANDOFF — codebase-graph-mcp

> Sticky-note orientation for the next session. Repo uses SemVer + Keep-a-Changelog; `roadmap/` (this dir) is the planning/agent surface. Currently at **v0.2.2** (2026-06-01).

## Where we are
- **v0.2.2 shipped** today: Test-case symbol extraction (`Test` node label + working `TESTS` edges), incremental-prune fix (deletion-only events now prune; `pruneDeletedFiles` made atomic), parse-anomaly false-positive cleanup, and `index_status` now reports the **full** anomaly file list (not a 5-sample truncation).
- **An in-flight session may have uncommitted work in CHANGELOG `[Unreleased]`** (currently shows "No changes yet" — reconcile/`git status` before starting, especially anything touching `indexingPipelineIncremental.ts`).
- A two-wave plan was just drafted (2026-06-01) from a research + architecture pass. Both wave files are in this dir.

## What's next — execute in order
1. **`roadmap/wave-1-wiring-query-precision.md`** → ships as **0.3.0**, no new deps. Three phases:
   - P0 `resolution_method` provenance on edges (#4) · P1 HTTP real-URL+method extraction & matching (#1 — note: needs a **parser-layer** change, `ExtractedCall.firstArgValue`) · P2 Cypher `WITH`/negated-existence/pagination (#3).
   - This is the high-value, low-risk wave: it makes the gate actually verify wiring (today `httpLinkPass` matches caller-*name* vs route-*path* and never compares the real URL/method).
2. **`roadmap/wave-2-type-aware-resolution.md`** → ships as **0.4.0**, adds `ts-morph`. **Phase 0 is a GO/NO-GO spike** — do not build Phases 1-4 until it clears (cold-start < ~15s, ≥ 80% resolution coverage, demonstrable barrel/overload win). Locked ts-morph integration ADR is in the file (7 decisions).

## Key context / gotchas
- **Gate commands:** typecheck+build = `npm run build` (`tsc && node scripts/fix-extensions.mjs`); tests = `npm run test` (**Vitest**); **no linter configured** — no lint gate. CI matrix: Node 20+22 × ubuntu+windows.
- **Resolution is purely syntactic today** (tree-sitter, no type checker) — Wave 2 adds the type-aware tier. CALLS edges carry calibrated confidence (0.65–0.95); `insertEdge` is `INSERT OR REPLACE` (last write wins).
- **Storage = SQLite + a hand-rolled Cypher-subset engine** (not Neo4j/Kuzu). Do NOT migrate the backend — researched and rejected; the bottleneck is resolution precision + Cypher feature surface, not storage. (Also: Kuzu was Apple-acquired/archived Oct 2025 — do not adopt.)
- **CPU constraint:** one dev box can't tolerate heavy CPU work — Wave 2's ts-morph pass is gated behind a mandatory `skipTsEnrichment` flag for exactly this reason.

## Pointers
- Plan: `roadmap/wave-1-*.md`, `roadmap/wave-2-*.md`
- Pipeline: `src/indexingPipeline.ts` (8-pass orchestrator), `src/passes/` (+ `passes/CLAUDE.md`), `src/passes/httpLinkPass.ts` (#1 target), `src/cypherEngineNewFeatures.ts` (#3 extension point).

# Follow-up: Python precision tier (extend two-tier resolution beyond TypeScript)

- **Filed:** 2026-06-02 (after v0.4.0 / Wave 2 shipped the TS-only ts-morph precision tier)
- **Priority:** medium — driven by demand for high-fidelity Python analysis (primary use case: **Riftalytics**, a Python codebase)
- **Status:** OPEN

## The gap

v0.4.0 added a **two-tier resolution model**: tree-sitter is the always-on base tier (all 12 languages), and an opt-in **ts-morph precision tier** (Pass 6/7) upgrades CALLS/ASYNC_CALLS/TYPEOF_REFERENCES to `compiler_api` (0.98) and adds REFERENCES edges. That precision tier is **TypeScript-only** — it's built on ts-morph, which *is* the TypeScript compiler.

Consequence: every non-TS language (Python, Go, Rust, Java, …) sits at the tree-sitter base tier only. Python is **not** broken or unsupported — it gets full structure (File/Function/Class/Method, DEFINES/CONTAINS) and **real import-aware CALLS resolution** (`import_resolved` 0.95 / `same_file` 0.85 / `name_unique` 0.80, with `from y import x` actually parsed via `extractPythonFromStatement`). What it lacks is the precision layer:

- No `compiler_api` (0.98) confidence upgrade on calls
- No type-aware TYPEOF resolution
- No REFERENCES edges (type-only refs, decorators)

Wave 2 didn't create a Python deficiency — it gave TS a boost the other 11 languages don't share, widening the TS-vs-rest gap.

## Proposed approach

Build a **Python precision tier** architecturally parallel to Pass 6/7, but using Python tooling. The two-tier seam we shipped is designed to extend this way: a new `pythonEnrichmentPass` (Pass 8) slots next to the TS passes, gated by its own skip flag, no-op when its toolchain is unavailable.

1. **Spike first (mirror the Wave 2 Phase 0 ts-morph spike):** evaluate the Python static-analysis options against the same bars (cold-start time, ≥X% call-site resolution coverage, a demonstrable alias/dynamic-dispatch win tree-sitter name-matching drops).
   - **Pyright** — Microsoft's Python type checker; the closest analog to ts-morph (real type checker, language-server mode, precise import/symbol/alias resolution). Likely first choice.
   - **Jedi** — lighter, autocompletion/static-analysis library; lower setup cost, possibly weaker on some resolution cases.
   - **pyanalyze** / stdlib `ast` + a symbol resolver — fallback options.
2. **Reuse the locked architecture:** base tier untouched (tree-sitter stays the fallback for Python when the precision toolchain is absent); precision pass upgrades edges to `compiler_api` 0.98 and adds REFERENCES; per-(source,type) authoritative-but-guarded supersession (see `roadmap/decisions/edge-supersession-model.md`); skip-flag escape valve + graceful degradation (no toolchain / failure → no-op).
3. **Cross-process consideration:** unlike ts-morph (in-process Node), a Python analyzer is a separate runtime — the integration likely spawns a Python subprocess / LSP and crosses an IPC boundary. That's the main architectural difference from the ts-morph tier and the main spike risk (latency, process lifecycle, serialization). Treat it as boundary work.

## References

- Architecture to extend: `roadmap/decisions/two-tier-resolution-model.md`, `roadmap/decisions/edge-supersession-model.md`
- Pattern to mirror: Wave 2 (`roadmap/wave-2-type-aware-resolution.md` stub; full plan in git at `a121e53`), passes `src/passes/typescriptEnrichmentPass.ts` (Pass 6) and `src/passes/referencesPass.ts` (Pass 7)
- ts-morph vendor lessons (for what to anticipate from a language-toolchain integration): `.claude/vendor-gotchas/ts-morph.md`
- Language registry (where a Python tier hooks in): `src/treeSitterLanguageConfigs.ts` (pythonConfig), `src/indexingPipelineCallResolution.ts` (language-agnostic base resolution)

## Scope note

This is a full wave's worth of work (SDK spike + integration + cross-process boundary), not a flag flip. Generalizes beyond Python — the same pattern would later bring Go/Rust/etc. to parity, each with its own toolchain.

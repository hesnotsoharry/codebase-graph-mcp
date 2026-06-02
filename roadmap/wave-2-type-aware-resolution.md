# Wave 2 — Type-Aware Resolution (SHIPPED — v0.4.0, 2026-06-02)

> Collapsed stub. The full plan (locked decisions D1–D7 + D5.1, phase specs, risks) lives in git history — see the release commit `a121e53` and the P0–P4 commits below.

**Shipped:** a two-tier resolution model. tree-sitter stays the always-on structural pass; a new opt-in **ts-morph precision tier** (Pass 6, `typescriptEnrichmentPass`) upgrades `CALLS`/`ASYNC_CALLS`/`TYPEOF_REFERENCES` through barrels, overloads, and generics at **0.98/compiler_api**. New first-class **REFERENCES edges** (Pass 7, `referencesPass`) capture type-only references, decorators, and JSX uses for blast-radius completeness. Gated behind a mandatory `skipTsEnrichment` flag with graceful degradation. New dependency: `ts-morph@28` (bundles TS 6.0.2). Also folded in the long-standing `totalNodes/totalEdges`-stuck-at-0 reporting fix.

**Phase 0 spike (GATE: GO):** cold-start 801ms, resolution 212/212 = 100%, 3 barrel-wins; bundled TS 6.0.2 ≥ repo 5.7.2.

**Durable decisions:** [`roadmap/decisions/two-tier-resolution-model.md`](decisions/two-tier-resolution-model.md) · [`roadmap/decisions/edge-supersession-model.md`](decisions/edge-supersession-model.md)
**Vendor gotchas:** `.claude/vendor-gotchas/ts-morph.md`
**Open follow-up:** `roadmap/follow-ups/2026-06-02-launch-diff-skip-tsenrichment.md`

**Commits:** `478838b` (P0 spike) · `29d0be2` (P1 infra) · `8c93224` (P2 CALLS/ASYNC_CALLS) · `467e1bb` (P3 TYPEOF + incremental) · `e56be3a` (P4 REFERENCE edges) · `e3e0b5f` (reporting fix) · `a121e53` (release v0.4.0).

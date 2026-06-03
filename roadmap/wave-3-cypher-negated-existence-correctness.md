---
status: SHIPPED
shipped: 2026-06-02
commits: 78f1f7a..4e3a521
---
# Wave 3: cypher-negated-existence-correctness

Result: Edge-type alternation `[:T1|T2|...]` in negated-existence Cypher (`type IN (...)`), fixing the dead-code false-positive for functions called only via `ASYNC_CALLS`; single-type path byte-identical (regression-safe). Varpath queries now fail loud on `NOT` clauses instead of silently dropping them. Also repaired a pre-existing v0.4.1 break (test fixtures missing required `ParsedFileResult` anomaly fields). Shipped v0.5.0. Full suite 870 passed / 3 skipped; mechanical review PASS; per-phase + wave-end adversarial PASS.

Promoted: none (both Locked Decisions wave-local)
Vendor-gotchas updated: none (pure internal logic)
Follow-ups: resolved+archived verify-wave-dead-export-engine-support; filed parameterize-edge-type-list; surfaced meta skill-update (codebase-memory-quality → alternation syntax)

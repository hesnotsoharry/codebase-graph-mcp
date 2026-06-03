---
status: SHIPPED
shipped: 2026-06-02
commits: 1a1816a..1a31f99
---
# Wave 4: edge-type-hygiene-launchdiff-skip

Result: Parameterized edge-type values as bound `?` params in `buildNotExistsSql` (P1); `search_graph` degree filter now accepts a union of relationship types — `"CALLS|ASYNC_CALLS"` or array — fixing async-only-called functions mis-counted as zero in-degree (P2); `launch-diff` `skipTsEnrichment` flag skips the ts-morph enrichment passes (Pass 6/7) (P3). Backward-compatible; tsc clean, full suite 883 pass. Released v0.6.0.

Promoted: none (Decision 0 was planner-resolved, not durable).
Vendor-gotchas updated: none (skipTsEnrichment was already anticipated in ts-morph.md).
Follow-ups: filed `parameterize-remaining-edge-type-sql-builders` (3 inline edge-type SQL sites left out of scope); resolved + archived `parameterize-edge-type-list-buildnotsexists` (P1) and `launch-diff-skip-tsenrichment` (P3). Mechanical review FLAG (Check 2) justified out-of-scope.

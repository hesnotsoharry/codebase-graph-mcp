---
project: codebase-graph-mcp
updated: 2026-06-02
---

## Current state
- Branch: main · Latest commit: 4e3a521 · Tag: v0.5.0
- Active wave: none · Status: between waves (Wave 3 shipped)

## Next 3 steps
1. Restart Claude Code sessions to pick up v0.5.0 dist (MCP server runs dist/index.js — alternation + varpath fail-loud now live).
2. META follow-up: update global `codebase-memory-quality` skill's dead-code query from `NOT ()-[:CALLS]->(n)` to `NOT ()-[:CALLS|ASYNC_CALLS]->(n)`.
3. Optional hardening: roadmap/follow-ups/2026-06-02-parameterize-edge-type-list-buildnotsexists.md (bind params vs inline SQL in buildNotExistsSql).

## Active work
- Open follow-ups: 4 — launch-diff-skip-tsenrichment, python-precision-tier, heuristic-http-edges-false-positive, verify-wave-pipeline-memory-reconcile. Plus 1 new: parameterize-edge-type-list.
- Wave 3 shipped: edge-type alternation `[:CALLS|ASYNC_CALLS]` in negated-existence Cypher (fixes dead-code false-positive for async-only-called fns); varpath queries fail loud on NOT clauses; test fixtures now have required ParsedFileResult fields.
- Full suite: 870 passed / 3 skipped. tsc clean. Build clean. Verify-wave-dead-export-engine-support resolved + archived.

## Reference index
- Cypher engine: src/cypherEngineParser.ts (parseNegatedExistence), src/cypherEngineSqlHelpers.ts (buildNotExistsSql), src/cypherEngineVarpath.ts (fail-loud invariant)
- Two-tier model: [decisions/two-tier-resolution-model.md](decisions/two-tier-resolution-model.md)
- Vendor-gotchas: [.claude/vendor-gotchas/ts-morph.md](../.claude/vendor-gotchas/ts-morph.md)
- Project conventions: [../CLAUDE.md](../CLAUDE.md)

---
project: codebase-graph-mcp
updated: 2026-06-02
---

## Current state
- Branch: main · Latest commit: a121e53 (v0.4.0 shipped) · Tag: v0.4.0
- Active wave: none · Status: between waves · Full suite: 855 passed / 3 skipped

## Next 3 steps
1. Restart Claude Code sessions to pick up v0.4.0 (codebase_graph MCP server runs dist/index.js)
2. Monitor open follow-ups: launch-diff skipTsEnrichment contract issue + Wave 1 http-edges false-positive watch
3. Dispatch Wave 3 plan when ready (no automation pending)

## Active work
- Wave shipped: wave-2-type-aware-resolution.md (collapsed to stub; full history in git)
- Open follow-ups: 2 · [follow-ups/](follow-ups/) — top item: launch-diff-skip-tsenrichment.md
- Recent CI: Node 20+22 × ubuntu+windows matrix — CONFIRM green before proceeding

## Reference index
- Two-tier model: [decisions/two-tier-resolution-model.md](decisions/two-tier-resolution-model.md)
- ts-morph gotchas: [.claude/vendor-gotchas/ts-morph.md](../.claude/vendor-gotchas/ts-morph.md)
- Passes: src/passes/{typescriptEnrichmentPass,referencesPass}.ts · src/passes/CLAUDE.md
- Project conventions: [../CLAUDE.md](../CLAUDE.md)

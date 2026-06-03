---
status: RESOLVED
created: 2026-06-02
resolved: 2026-06-02
origin: meta wave M-48 (declared-but-never-wired audit)
priority: low
---

> **RESOLVED 2026-06-02.** Decision: DROP verify-wave from this repo's auto-default (it works here — dead-export scan runtime-validated, 185 candidates under the row cap — but output is noisy: test helpers + entrypoints). Aligns with M-48 global demote. Opt-in migrated to the new tracked root `CLAUDE.md` § Meta/Process (run-phase + wrap-wave auto; verify-wave manual-only, with the runtime-validated note). Stale memory file `use-workflow-pipeline-default.md` deleted + MEMORY.md index updated. verify-wave engine confirmed capable via live `query_graph` smoke this session.

# Reconcile the project's "auto-run verify-wave" memory with meta's M-48 demote

## Why this follow-up is in THIS repo (context for future codebase-graph-mcp agents)

A **meta-framework wave (M-48, 2026-06-02)** demoted `verify-wave.workflow.js` from "default
wave-end step" to **manual-invoke** (because on most repos its dead-export scan always returns
DEFERRED — see the companion follow-up `2026-06-02-verify-wave-dead-export-engine-support.md`).

This creates a contradiction with **this project's auto-memory**:

- `~/.claude/projects/C--Web-App-codebase-graph-mcp/memory/use-workflow-pipeline-default.md` records
  that Cole authorized the Workflow pipeline as this project's standing default, and explicitly lists
  **`verify-wave` at wave-end** among the auto-defaults ("invoke ... `verify-wave` at wave-end").
- After M-48, verify-wave is globally manual-invoke. A session here that loads that memory at start
  would auto-run verify-wave — which, unless this repo's graph is reliably indexed AND under the
  ~200-function row cap, just produces a DEFERRED no-signal result.

## What to do

Decide, as the repo that owns the graph engine, which is true here and reconcile the memory:

- **If this repo's graph is reliably indexed and under the row cap** (it's plausible — this is the
  graph tool's own repo) → verify-wave may genuinely be useful here. Keep it as a *deliberate,
  documented project-local choice* and note in the memory that this is an intentional exception to
  meta's global demote (with the reason: this repo's graph supports it).
- **Otherwise** → update the memory note to drop `verify-wave` from the auto-default list (keep
  `run-phase` + `wrap-wave`), aligning with the M-48 demote until the engine fix lands.

Either way: edit `use-workflow-pipeline-default.md` so a future session here isn't given a stale
"auto-run verify-wave" instruction without the M-48 context.

## Broader action (M-48 Decision 2): migrate opt-in memory → tracked CLAUDE.md

M-48 Decision 2 established that a project's workflow opt-in must live in a **user-authored, repo-tracked** file (checked-in `CLAUDE.md` or `.claude/` config), NOT in agent memory (untracked, stale-prone). So the full resolution for `use-workflow-pipeline-default.md` is: (1) move the pipeline-default opt-in directive into this repo's checked-in `CLAUDE.md` as a user-confirmed standing directive (dropping `verify-wave` from the auto-list per the verify-wave reconciliation above, keeping run-phase + wrap-wave), then (2) DELETE the memory file `~/.claude/projects/C--Web-App-codebase-graph-mcp/memory/use-workflow-pipeline-default.md`. This makes the opt-in tracked + reviewable. Have Cole confirm the CLAUDE.md wording (it's a user-authored directive).

## Cross-references

- Companion engine fix: `2026-06-02-verify-wave-dead-export-engine-support.md` (this repo)
- Meta wave + decision: `meta/roadmap/wave-m48-enforcement-wiring.md` Phase 2
- The memory file to reconcile: `~/.claude/projects/C--Web-App-codebase-graph-mcp/memory/use-workflow-pipeline-default.md`

---
title: Monitor heuristic-fallback HTTP_CALLS edge false-positive rate
opened: 2026-06-01
wave: wave-1-wiring-query-precision
status: open
priority: low
type: watch-item
---

## Context
Wave 1 made `HTTP_CALLS` matching precise for statically-resolvable URLs (`url_literal` at 0.95, `url_template` at 0.8). URLs that **cannot** be statically resolved — axios instances with a `baseURL`, `base + path` string concatenation, other computed URLs — fall back to the caller-name / route-path string heuristic at confidence ≤ 0.5 (`resolution_method = 'heuristic_name'`) and are **never dropped** (a low-confidence edge beats a missing one).

## The watch item
The `heuristic_name` edge class is a known low-confidence band, accepted by design. Its **false-positive rate is unmeasured**. This is a monitoring item, not committed work.

## Action (revisit-if)
If the `heuristic_name` class is observed to produce a high false-positive rate in practice — e.g. surfaced once graph-backed gate checks are running against real projects — tighten the heuristic or lower its emission threshold. Until then, no action. The graph-backed measurement is itself currently blocked by the `codebase_graph` MCP server not being attached (see HANDOFF).

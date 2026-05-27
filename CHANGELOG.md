# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Repository graduated to a dedicated public home at <https://github.com/hesnotsoharry/codebase-graph-mcp>. Previously, the source had no public GitHub home — only the npm artifact existed for consumers.
- README rewritten to reflect v0.1.0 reality (the previous README documented an unrelated monorepo path layout and a "Phase 1 walking skeleton" tool surface containing only `ping`, when the package actually ships 15 tools).
- `package.json` metadata extended: `repository.url`, `bugs.url`, `homepage`, `keywords`. Description fixed to no longer reference "Ouroboros" — the package is standalone and that name no longer applies.
- **Storage path renamed** from `~/.ouroboros-graph/<hash>/graph.db` to `~/.codebase-graph/<hash>/graph.db`. A silent auto-migration helper runs on every `buildDbPath()` call: if `~/.ouroboros-graph/` exists and `~/.codebase-graph/` does not, the directory is moved atomically (`fs.renameSync`). If both exist, non-colliding hash subdirectories are migrated individually; colliding subdirectories are left untouched and a warning is emitted to stderr so the user can clean up manually. No data is deleted in any scenario. Upgrading from 0.1.0 is zero-friction.

### Added
- `LICENSE` (MIT).
- `CONTRIBUTING.md` with issue/PR policy and local development setup.
- GitHub Actions: `ci.yml` (build + test on Node 20+22 × ubuntu-latest + windows-latest), `publish.yml` (`npm publish` on GitHub release).
- Issue templates: bug report, feature request, Windows registration failure.

## [0.1.0] - 2026-05-26

Initial standalone release. Extracted from a private upstream codebase as part of work distributing the codebase-graph MCP server to multiple Claude Code consumers.

### Added
- MCP server exposing 15 tools for codebase graph queries:
  - **Project management:** `list_projects`, `delete_project`
  - **Indexing:** `index_repository`, `index_status`, `ingest_traces`
  - **Search:** `search_graph`, `search_code`, `get_code_snippet`
  - **Traversal:** `trace_call_path`, `get_architecture`, `detect_changes`
  - **Schema introspection:** `get_graph_schema`, `query_graph` (simplified Cypher subset)
  - **ADR:** `manage_adr`
  - **Health:** `ping`
- Tree-sitter parsing across 30+ languages via `tree-sitter-wasms` + `web-tree-sitter`.
- SQLite persistence via `better-sqlite3` (graph stored at `~/.ouroboros-graph/<project-hash>/graph.db` — this storage path is scheduled to rename to a neutral location in v0.2.0).
- File-watcher-driven incremental reindex via `@parcel/watcher`, with polling reconciliation as a safety net for missed events.
- Cypher-like query engine (`queryGraph`) supporting a subset of openCypher pattern matching.
- Node.js ≥ 20 ESM-compatible build (`scripts/fix-extensions.mjs` post-processes `tsc` output to add `.js` extensions for Node ESM resolution).

### Patched in 0.1.0
- `aa5f37b` (post-publish): added `p-limit` and `ignore` as direct deps — both were transitively inherited from the source monorepo and missing from the standalone `package.json`. Without these, `npm install` on a fresh consumer environment fails.

[Unreleased]: https://github.com/hesnotsoharry/codebase-graph-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hesnotsoharry/codebase-graph-mcp/releases/tag/v0.1.0

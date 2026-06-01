# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

(No changes yet.)

## [0.2.2] - 2026-06-01

### Added
- **Test-case symbol extraction → working TESTS edges for test files.** Test frameworks write cases as call-expression arguments (`describe('s', () => …)`, `it('case', () => …)`), which the prior extractor — limited to top-level `function` declarations and `const fn = () =>` — never captured. Such test files produced zero symbols, so `testDetectPass` had no anchor and emitted zero TESTS edges. A new `extractTestCaseDefinitions` pass (`src/treeSitterTestExtractor.ts`) walks `call_expression` nodes, recognizes the Vitest/Jest/Mocha globals (`it`/`test`/`xit`/`fit`/`it.only`/… as leaf cases; `describe`/`suite`/`context`/… as structural scoping), and emits a new **`Test`** node per case (name = describe-chain-prefixed description, e.g. `UserService>creates a user`). `testDetectPass` now anchors TESTS edges off `Test` nodes as well as `Function` nodes. Dynamic test names (`it(variable, …)`, template literals) are skipped gracefully; table-driven `it.each(table)(name, fn)` is deferred to v0.3 (treated as structural for now).
- **New `Test` node label** in the graph schema (no DB migration — `nodes.label` has no CHECK constraint). Kept distinct from `Function` so human-readable test descriptions don't pollute `search_graph`/FTS or the production-symbol surface.

### Fixed
- **Incremental indexing never pruned deleted files (orphan-node accumulation).** A fast-path guard in `resolveIncrementalFiles` (`indexingPipelineIncremental.ts`) returned early whenever no file was *modified*, skipping the prune step entirely. A deletion-only event (file removed, nothing else changed) hit this path, so the deleted file's nodes + edges persisted forever — incremental indexes drifted upward indefinitely (observed: a project at 3471 nodes that a clean full reindex put at 1828). The guard now calls `pruneDeleted(allFiles)` before returning (a cheap no-op when nothing was deleted).
- **`pruneDeletedFiles` was not atomic.** Each deleted file's two writes (`deleteNodesByFile` + `deleteFileHash`) are now wrapped in a per-file transaction, so a mid-loop crash can no longer leave nodes deleted while the hash record survives (which would make the file appear "unchanged" forever and never re-index).
- **Parse-anomaly false positives on config/script files.** Pure-config modules (`*.config.{js,ts,cjs,mjs}`, `.dependency-cruiser.*`) and zero-call/zero-import data modules parse cleanly but legitimately have no named functions; they are no longer flagged as anomalies. (Most prior test-file "anomalies" also disappear now that test cases are extracted as symbols.)

### Changed
- **`index_status` now reports the full anomaly file list, not a 5-sample truncation.** `countParseAnomalies` persists the complete list; `ParseAnomalyResult.samples` → `files`. Reads fall back to the old `samples` key for DBs written by pre-0.2.2 builds, so no forced reindex is required on upgrade.

## [0.2.1] - 2026-06-01

### Fixed
- **Duplicate per-project databases from non-canonical root paths.** `buildDbPath()` hashed the raw `--root` string (or its `process.cwd()` fallback) with no normalization, so the same folder spelled two ways — `C:\Web App\X` (backslash, from a cwd fallback) vs `C:/Web App/X` (forward-slash, from an explicit `--root`) — produced two different `~/.codebase-graph/<hash>/` directories and indexed the project twice (observed on Windows: 5 real projects sprawled to 17 DBs, including an accidental whole-home index from a no-`--root` server launched in the home dir). The hash input is now canonicalized via a new pure, exported `rootHash()` helper (`path.resolve()` + backslash→forward-slash + lowercase), folding separator style, trailing slashes, and drive-letter case to a single hash. Existing databases re-hash to new directories and re-index once on next use. Regression coverage in `serverBootstrap.rootHash.test.ts`.

## [0.2.0] - 2026-05-27

### Added
- **Lazy auto-index on first graph-tool invocation.** The server no longer requires an explicit `index_repository` call before queries return meaningful results. The first invocation of any graph-data tool checks DB readiness: empty DB triggers a full index; stale DB (source-tree signature differs) triggers an incremental index; fresh DB serves immediately. Staleness checks are rate-limited to once per 60 seconds after first verification. Health-check and lifecycle tools (`ping`, `index_repository`, `index_status`, `list_projects`, `delete_project`) bypass the check. Stderr progress lines (`[trace:graph-mcp.auto-init] ...`) surface in MCP client logs.
- **`find_typeof_references` MCP tool + `TYPEOF_REFERENCES` graph edge type.** The indexer's call-resolution pass previously skipped type-only references; `ReturnType<typeof X>`, `Parameters<typeof X>`, `InstanceType<typeof X>`, `Awaited<ReturnType<typeof X>>`, `keyof typeof X`, and plain `typeof X` patterns are now captured as distinct `TYPEOF_REFERENCES` edges (separate from `CALLS` to preserve runtime-vs-type-level semantics). The new tool surfaces type-level consumers of a symbol — essential for refactor-planning when CALLS edges alone miss the consumers. Tool count grows 15 → 16.
- `LICENSE` (MIT).
- `CONTRIBUTING.md` with issue/PR policy and local development setup.
- GitHub Actions: `ci.yml` (build + test on Node 20+22 × ubuntu-latest + windows-latest), `publish.yml` (`npm publish` on GitHub release with `--provenance`).
- Issue templates: bug report, feature request, Windows registration failure.

### Changed
- **Storage path renamed** from `~/.ouroboros-graph/<hash>/graph.db` to `~/.codebase-graph/<hash>/graph.db`. A silent auto-migration helper runs at the top of `buildDbPath()`: if the old path exists and the new path does not, the directory is moved atomically (`fs.renameSync`). If the whole-tree rename fails (commonly EPERM on Windows when SQLite locks are held by other processes), the helper falls back to per-subdirectory migration, moving non-colliding subdirs individually with per-subdir error handling. If both directories exist, colliding subdirectories are left untouched and a warning is emitted to stderr so the user can resolve manually. No data is deleted in any scenario. Server startup never crashes from migration failure — old data is preserved at the old path until the next attempt.
- Repository graduated to a dedicated public home at <https://github.com/hesnotsoharry/codebase-graph-mcp>. Previously, the source had no public GitHub home — only the npm artifact existed for consumers.
- README rewritten to reflect package reality: Quickstart split macOS/Linux (`npx -y`) vs Windows (`node <abs-path>` after global install — CVE-2024-27980 PATHEXT regression workaround), 15-tool surface table, Indexing model, Troubleshooting, Verification, Logging sections. The previous README documented an unrelated monorepo path layout and a "Phase 1 walking skeleton" tool surface containing only `ping`, when the package actually shipped 14 graph tools.
- `package.json` metadata extended: `repository.url`, `bugs.url`, `homepage`, `keywords`, `license: "MIT"`, `author: "Cole Stacey"`. Description rewritten to drop the upstream Ouroboros reference — the package is standalone and that name no longer applies. `files` array gained `LICENSE` and `CHANGELOG.md` so they ship in the npm tarball.
- Internal de-ouroborosing sweep across the source tree: removed `Ouroboros` mentions in fallback paths, error strings, comments, and the dead `graphStore.ts` project-local path (marked with TODO for future removal).

### Patched in 0.1.0 → 0.2.0 transition
- `package-lock.json` regenerated to sync transitive dependencies (`@emnapi/core@1.10.0`, `@emnapi/runtime@1.10.0`) that drifted between the original v0.1.0 publish and the v0.2.0 release. CI's `npm ci` now succeeds across Node 20+22 × ubuntu-latest + windows-latest matrix.

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

[Unreleased]: https://github.com/hesnotsoharry/codebase-graph-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/hesnotsoharry/codebase-graph-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/hesnotsoharry/codebase-graph-mcp/releases/tag/v0.1.0

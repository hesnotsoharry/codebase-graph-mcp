# codebaseGraph — In-process codebase knowledge graph engine

Indexes source code into a graph of symbols and relationships. Runs entirely in
the main process with no external dependencies beyond tree-sitter WASM and
SQLite (better-sqlite3).

**Phase E complete**: System 1 (worker-thread + JSON store) has been removed.
System 2 (SQLite + indexing worker client + Cypher query engine) is the only
implementation. `GraphControllerCompat` is the permanent consumer API layer —
callers use `getGraphController()` and receive a `GraphControllerLike`.

## Key Files

| File | Role |
|------|------|
| `graphControllerSupport.ts` | Per-root registry (`setGraphController`, `getGraphController`, `getGraphControllerForRoot`, `acquireGraphController`, `releaseGraphController`). Defines `GraphControllerLike` — the stable consumer interface. |
| `graphControllerCompatRegistry.ts` | Multi-root acquire/release that wraps System 2 registry entries in `GraphControllerCompat` instances. Called by `graphControllerSupport.acquireGraphController`. |
| `graphControllerCompat.ts` | `GraphControllerCompat` — compat shim that implements `GraphControllerLike` over System 2 internals. The permanent consumer API boundary. |
| `graphControllerCompatAdapters.ts` | Adapter helpers used by `GraphControllerCompat` to bridge System 2 query results to the `GraphControllerLike` shape. |
| `graphControllerCompatQueries.ts` | Query implementations for `GraphControllerCompat`: `searchGraph`, `searchCode`, `queryGraph`, `traceCallPath`, `getArchitecture`, `getCodeSnippet`. |
| `graphDatabase.ts` | SQLite-backed graph database (better-sqlite3). Tables: `nodes`, `edges`, per-project catalog hash. All operations synchronous. |
| `graphDatabaseHelpers.ts` | Node/edge insert helpers, row mappers, schema migration utilities. |
| `graphDatabaseSchema.ts` | DDL constants and schema migration runner. |
| `graphDatabaseTraversal.ts` | BFS/DFS traversal helpers over the graph DB. |
| `graphDatabaseTypes.ts` | `GraphNode`, `GraphEdge`, `NodeLabel`, `EdgeType`, `ProjectRecord`, and related type definitions used by System 2. |
| `graphStore.ts` | SQLite-backed `GraphStore` implementing `IGraphStore`. Used by `graphController`-level tests that validate node/edge CRUD via the shared interface. |
| `graphStoreTypes.ts` | `IGraphStore` interface — implemented by `GraphStore`. |
| `graphTypes.ts` | Legacy shared types: `GraphNode`, `GraphEdge`, `IndexStatus`, `ArchitectureView`, `SearchResult`, `CallPathResult`, `ChangeDetectionResult`, `GraphSchema`, `GraphToolContext`. Still used by `GraphControllerLike` surface and some consumers. |
| `indexingPipeline.ts` | Orchestrates a full or incremental index run: file discovery → tree-sitter parse → DB upsert. |
| `indexingPipelineCallResolution.ts` | Post-parse call-edge resolution pass. |
| `indexingPipelinePasses.ts` | Pluggable pipeline passes (enrichment, git co-change, HTTP links, test detection). |
| `indexingPipelineStructure.ts` | File structure analysis helpers for the pipeline. |
| `indexingPipelineSupport.ts` | Shared utilities for the pipeline (file hash, mtime, path normalization). |
| `indexingPipelineTypes.ts` | `IndexingOptions`, `IndexingProgress`, `IndexingResult`, `DiscoveredFile`, `IndexedFile`. |
| `indexingWorker.ts` | Worker thread entry point for CPU-bound tree-sitter parsing. Receives messages from `IndexingWorkerClient`. |
| `indexingWorkerClient.ts` | Main-thread client — spawns the worker, sends `runIndex` jobs, relays `onProgress` callbacks. |
| `indexingWorkerTypes.ts` | Worker message protocol types (`WorkerRequest`, `WorkerResponse`). |
| `queryEngine.ts` | `QueryEngine` — search, trace, architecture, change-detection over the graph DB. |
| `queryEngineSupport.ts` | Query helpers shared by `QueryEngine` and `CypherEngine`. |
| `queryEngineTypes.ts` | Query result types: `SearchResult`, `TraceResult`, `ArchitectureResult`, `DetectChangesResult`, etc. |
| `cypherEngine.ts` | `CypherEngine` — executes simplified Cypher-like queries against the graph DB. |
| `cypherEngineParser.ts` | Cypher query string parser. |
| `cypherEngineSupport.ts` | Execution helpers for `CypherEngine`. |
| `cypherEngineVarpath.ts` | Variable-path traversal for Cypher relationship patterns. |
| `treeSitterParser.ts` | `TreeSitterParser` — wraps tree-sitter WASM for TS/JS/Python/Go/Rust/Java/C++. |
| `treeSitterLanguageConfigs.ts` | Per-language extraction configs (node types, scope rules). |
| `treeSitterParserCalls.ts` | Call-edge extraction from tree-sitter ASTs. |
| `treeSitterParserDefs.ts` | Definition extraction (functions, classes, interfaces, etc.). |
| `treeSitterParserImports.ts` | Import/export extraction. |
| `treeSitterParserSupport.ts` | Shared cursor-walk helpers (`findDescendantsOfType`). |
| `treeSitterTypes.ts` | Extraction result types. |
| `autoSync.ts` | `AutoSyncWatcher`. Watcher-first via `@parcel/watcher`; polling is a 1–10 min reconciliation safety net for missed events, not the primary detection mechanism. |
| `systemTwoRegistry.ts` | Core acquire/release registry keyed by root path, ref-counted. Manages watcher lifecycle. |
| `systemTwoRegistryTypes.ts` | Registry handle and config types. |
| `concurrency.ts` | Async mutex / concurrency helpers used by the pipeline. |
| `graphGc.ts` | GC: prunes stale project graphs from the DB based on last-opened timestamp. |
| `mcpToolHandlers.ts` | MCP tool implementations exposed to Claude Code via the internal MCP server. |
| `mcpToolHandlerDefs.ts` | Tool definition objects (name, description, input schema). |
| `mcpToolHandlerHelpers.ts` | Shared formatting helpers for MCP tool responses. |
| `detectChangesForSessionTypes.ts` | Types for per-session change detection results. |
| `passes/` | Enrichment passes run after initial indexing (git co-change, HTTP links, test detection). |

## Architecture

```
initCodebaseGraph() (mainStartup.ts)
  └── initCompatRegistry(db, queryEngine, cypherEngine, workerClient)
  └── GraphControllerCompatRegistry.acquireGraphController(root, pipeline)
       └── SystemTwoRegistry.acquire(root, db, pipeline)
            └── AutoSyncWatcher (@parcel/watcher) → incremental reindex on changes
       └── new GraphControllerCompat(handle)
            ├── QueryEngine    (search, trace, architecture, detect-changes)
            ├── CypherEngine   (queryGraph — simplified Cypher subset)
            └── IndexingWorkerClient → IndexingWorker (worker thread)
                 └── TreeSitterParser → GraphDatabase (better-sqlite3)

Consumers call getGraphController() → GraphControllerLike
```

## Consumer API (`GraphControllerLike`)

The stable interface that all consumers depend on. Defined in `graphControllerSupport.ts`, implemented by `GraphControllerCompat`:

| Method | Description |
|--------|-------------|
| `searchGraph(query, limit?)` | Fuzzy symbol search |
| `traceCallPath(fromId, toId, maxDepth?)` | BFS call-path between two symbols |
| `getArchitecture(aspects?)` | Hotspots, modules, file tree |
| `getCodeSnippet(symbolId)` | Source snippet + dependencies for a symbol |
| `queryGraph(query)` | Simplified Cypher query |
| `searchCode(pattern, opts?)` | Regex search across source files |
| `detectChanges()` | Files changed since last index |
| `detectChangesForSession(sessionId, files)` | Per-session blast radius |
| `indexRepository(opts)` | Trigger explicit re-index |
| `onSessionStart() / onGitCommit() / onFileChange(paths)` | Event hooks for incremental sync |
| `getStatus()` / `indexStatus()` | Index health info |
| `manageAdr(action, id?)` | ADR stub (file-system redirects) |
| `ingestTraces(traces)` | Ingest external call traces |

## Startup Sequence

1. `mainStartup.initCodebaseGraph()` is called from `main.ts` after app is ready.
2. A shared `GraphDatabase` is created and injected via `setSystem2Db()`.
3. `initCompatRegistry(deps)` stores the shared DB, query/cypher engine factories, and worker client.
4. `acquireCompatController(root, pipeline)` creates the default-root `GraphControllerCompat`.
5. `setGraphController(compat)` registers it as the default root in `graphControllerSupport`.
6. Background: `IndexingWorkerClient.runIndex()` fires if the catalog hash is stale or node count is zero.

## Gotchas

- **`getGraphController()` may return null** at startup if the graph hasn't initialized yet. All consumers must handle `null`.
- **`acquireGraphController(root)`** is called per window from `windowManager.ts`. It reuses the shared DB via `_system2Db`. First window uses startup-injected DB; subsequent windows reuse it.
- **Initial index fires on ANY cold acquire, not just `defaultProjectRoot`**: `acquireGraphController` invokes the injected `ensureIndexed(projectName, projectRoot)` callback on the new-root branch only (repeat acquires return early and do not re-index). The callback runs `resolveIndexReason` → `runInitialIndex` for cold projects (0 nodes / hash mismatch / post-GC). Reason: previously only the single startup `defaultProjectRoot` was ever indexed, so a project opened only as a secondary window root (e.g. Gamify) was never indexed — the watcher can't bootstrap a cold project because its change-diff short-circuits on zero stored hashes. The `ensureIndexed` indirection keeps Electron broadcast deps out of the registry (callback is built in `mainStartupGraph.ts`).
- **`initCompatRegistry()` must be called first** — `acquireGraphController` will throw `[compat-registry] initCompatRegistry() not called` if the registry hasn't been initialized.
- **`graphStore.ts` is System 2** — it's the SQLite-backed `IGraphStore` implementation used by test utilities. Not the old in-memory JSON store.
- **`graphTypes.ts` is legacy** — defines `GraphNode` / `GraphEdge` / etc. as used by the `GraphControllerLike` surface. `graphDatabaseTypes.ts` defines the System 2 DB-layer types (different shape). Some adapters bridge between the two.
- **`GraphControllerCompat` is permanent** — it's the abstraction boundary. Do not bypass it to call System 2 internals from consumers.
- **Worker path** — `indexingWorkerClient.ts` resolves the worker path using `__dirname` with an `endsWith('chunks')` check for asar packaging. Same pattern as the old `resolveWorkerPath` from System 1.
- **GC runs at startup** — `graphGc.pruneExpiredProjects()` fires before the initial index if `codebaseGraph.gcEnabled` is true. Pruned project names are tracked to force a full reindex.
- **autoSync poll loop scans a sliced window**: `pollForChanges` walks at most `MAX_FILES_PER_POLL` records per cycle (with a rolling `scanOffset` that wraps), parallelized at concurrency 32. The cap is iteration-count, not changed-count. Reason: a 0-changes scan must still terminate inside the per-cycle budget; capping on results means an unchanged repo iterates the entire catalog every cycle and blocks the event loop. Investigated in Wave 53k follow-up; freezes were 5–10 s on medium repos before the fix.
- **Worker import graph must avoid `electron`**: anything imported by `indexingPipeline` (or anything else loaded inside `indexingWorker.ts`) runs in a `worker_threads` context with NO `electron` module. Transitive imports matter — pulling in a barrel like `ipc-handlers/gitOperations` drags in agentChat → electron → tokenRefreshManager and the worker crashes at load time in packaged builds (works in dev because dev's loader resolves `electron` differently). Reason: `gitCoChangePass` originally imported `gitTrimmed` from `ipc-handlers/gitOperations`; in v2.19.3 packaged builds this killed the indexer at startup. Fix pattern: use the pure helpers in `src/main/util/gitExec.ts` for worker-side code, never the IPC-handler convenience wrappers.
- **`definitionPass` uses two-phase node-then-edge insertion** (Wave 19 FK fix): all node-phase chunks complete across ALL 500-file chunks before any edge-phase chunk runs. This prevents FK violations when a DEFINES_METHOD or HANDLES edge's target node is committed in a later chunk. Do NOT revert to single-phase (nodes+edges in same chunk transaction) — it re-introduces the FK violation on large projects. The two-phase split is in `indexingPipelinePasses.ts: definitionPass`.
- **`addRouteNodes` uses the ROUTE file's `fileQn` for HANDLES target_id**: `target_id = ${routeFileQn}.handlerName`. This is only valid when the handler function is defined in the SAME file as the route. Cross-file handler references produce wrong node IDs and the edge will fail FK (or be silently dropped by Fix B). The parser limitation is known; the fix would require cross-file handler resolution in a later pass.
- **`callResolutionPass` filters edges against `symbolsByName` before insert** (Wave 19 Fix B): edges whose `source_id` or `target_id` isn't in `symbolsByName` are dropped pre-insert. This prevents FK violations when a definition chunk failed and left some symbol nodes absent. Do NOT remove the `filterEdges` call — it's the defense-in-depth safety net for any future definition pass failures.
- **Standalone MCP server dist/ requires .js extensions for Node ESM** (Wave 22 Phase 4): TypeScript with `"module": "ESNext"` emits extensionless relative imports. Node v20+ ESM (`"type": "module"`) cannot resolve them. The build script runs `scripts/fix-extensions.mjs` post-tsc to rewrite all `from './foo'` → `from './foo.js'` in dist/. Do NOT remove this step or Node ESM resolution breaks.
- **TreeSitterParser requires `parser.init()` before first use** (Wave 22 Phase 4): `IndexingPipeline` does not auto-init the parser. In the standalone MCP server, `serverBootstrap.ts` wraps the pipeline in a lazy init shim that calls `parser.init()` on the first `index()` call. Reason: `Parser.init()` is async (WASM load) and can't be called synchronously at construction time.
- **`require.resolve` fails in Node ESM** (Wave 22 Phase 4): `treeSitterParser.ts` used bare `require.resolve()` to locate WASM files. In Node ESM (standalone dist/), `require` is undefined. Fixed by replacing with `createRequire(import.meta.url)`. This works in all contexts: Vitest (CJS-interop), Electron-vite (CJS bundle), and standalone Node ESM.

## Dependencies

- **Runtime**: `better-sqlite3` (graph DB), `web-tree-sitter` (WASM parser), `tree-sitter-wasms` (pre-built grammars for 30+ languages)
- **Consumed by**: `src/main/orchestration/graphSummaryBuilder.ts`, `src/main/ipc-handlers/graphHandlers.ts`, `src/main/ipc-handlers/filesHelpers.ts`, `src/main/ipc-handlers/gitOperations.ts`, `src/main/hooksLifecycleHandlers.ts`, `src/main/hooksSessionHandlers.ts`, `src/main/agentConflict/conflictMonitorSupport.ts`, `src/main/windowManager.ts`, `src/main/internalMcp/`

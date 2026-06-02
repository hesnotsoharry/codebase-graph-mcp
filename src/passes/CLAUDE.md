<!-- claude-md-auto:start -->
# passes/ — Post-indexing enrichment passes

Supplementary graph passes that run after the core tree-sitter indexing pipeline. Each pass receives an already-populated `GraphDatabase` and adds additional edges or updates node properties.

## Key Files

| File | Role |
|------|------|
| `passTypes.ts` | Shared types — `IndexedFile` and `IndexingPassContext` used by all passes |
| `enrichmentPass.ts` | Marks missed entry points (decorator-based, index-file exports, framework patterns) |
| `gitCoChangePass.ts` | Runs `git log` on the project root, creates `FILE_CHANGES_WITH` edges between files that co-change 3+ times in the last 200 commits |
| `httpLinkPass.ts` | Scans call sites for HTTP client patterns (`fetch`, `axios`, `requests`, `httpx`, etc.), creates `HTTP_CALLS` edges with 0.0–1.0 confidence scores linking callers to `Route` nodes |
| `testDetectPass.ts` | Identifies test files by naming convention, creates `TESTS` edges using two heuristics: name-based (test fn name contains subject fn name) and import-based |
| `typescriptEnrichmentPass.ts` | **Pass 6** — type-aware `CALLS`/`ASYNC_CALLS`/`TYPEOF_REFERENCES` resolution via ts-morph compiler API at 0.98 confidence. Supersedes tree-sitter heuristic edges (Phase 2: CALLS/ASYNC_CALLS; Phase 3: TYPEOF_REFERENCES). TS/TSX only. No-op when ts-morph Project is null. Exports `buildFileQn`, `buildSymbolQn`, `absoluteToRelative`, `getEnclosingFunctionName` for reuse by Pass 7. |
| `referencesPass.ts` | **Pass 7** — first-class `REFERENCES` edges for blast-radius completeness. Captures type-only references (TypeReference nodes), decorator uses, and JSX element uses that CALLS and TYPEOF miss. Source = function-level QN (enclosing function/method/class); deduped per (sourceQn, targetQn). 0.98/compiler\_api. TS/TSX only. No supersession (new edge type, no tree-sitter base). No-op when ts-morph Project is null. |

## Pass Interface

All passes follow the same functional signature — no class, no state:

```ts
export function xyzPass(db: GraphDatabase, projectName: string, projectRoot?: string): void
```

`IndexingPassContext` exists for bundling arguments if a pass needs all four fields, but passes can also accept them individually.

## Edge Types Added by Passes

| Edge | Created by | Meaning |
|------|-----------|---------|
| `FILE_CHANGES_WITH` | `gitCoChangePass` | Two files frequently co-committed (props: `{ count }`) |
| `HTTP_CALLS` | `httpLinkPass` | Function calls an HTTP endpoint (props: `{ confidence, http_method, resolution_method }`) |
| `TESTS` | `testDetectPass` | Test function exercises a production function |
| `REFERENCES` | `referencesPass` | Function/method/class references a type-only symbol (type annotation, decorator, JSX tag) with no CALLS edge — blast-radius completeness (Pass 7, Wave 2 Phase 4) |

## `resolution_method` provenance (Wave 1, Phase 0)

Every edge written by a resolution pass carries `props.resolution_method` — a string that records *how* the edge was resolved. Defined as `ResolutionMethod` in `graphDatabaseTypes.ts`.

| Value | Edge type | Meaning |
|-------|-----------|---------|
| `import_resolved` | `CALLS` / `ASYNC_CALLS` | Callee traced through an explicit import statement |
| `same_file` | `CALLS` / `ASYNC_CALLS` | Callee defined in the same file as the caller |
| `name_unique` | `CALLS` / `ASYNC_CALLS` | Callee name is unique project-wide (single candidate) |
| `new_expression` | `CALLS` / `ASYNC_CALLS` | `new X()` constructor — Class node preferred among candidates |
| `typeof_regex` | `TYPEOF_REFERENCES` | Detected by regex scan of type-position `typeof` |
| `url_literal` | `HTTP_CALLS` | Static literal URL path + method match (exact) → confidence 0.95 |
| `url_template` | `HTTP_CALLS` | Template-literal/param URL path + method match → confidence 0.8 |
| `heuristic_name` | `HTTP_CALLS` | Fell back to caller-name / route-path string heuristic (no static URL) → confidence ≤ 0.5 |
| `compiler_api` | `CALLS` / `ASYNC_CALLS` / `TYPEOF_REFERENCES` / `REFERENCES` | ts-morph type-checked resolution (Pass 6 Phases 2+3, Pass 7 Phase 4) — confidence 0.98; supersedes tree-sitter heuristic edges for CALLS/TYPEOF; new edge type for REFERENCES |

Querying example: `WHERE e.props ->> 'resolution_method' = 'import_resolved'` (SQLite `json_extract` syntax) or Cypher `WHERE e.resolution_method = 'import_resolved'` once the Cypher engine supports props dot-access.

## Gotchas

- **`gitCoChangePass` silently no-ops** if `git` is unavailable, not in a git repo, or `git log` fails — `getCommitFiles()` returns `null` on any exception. This is intentional; non-git repos must not crash indexing.
- **Commits touching >20 files are excluded** (`MAX_FILES_PER_COMMIT`) — large refactors/renames would create O(n²) spurious co-change pairs.
- **`httpLinkPass` confidence scoring** uses method match + caller-name/route-path string similarity. A wildcard `'*'` method pattern always matches but gets a lower base score. Edges below confidence threshold are not created.
- **IMPLEMENTS and EXTENDS edges are emitted from `definitionPass`** (since Wave 21, 2026-05-26), NOT from `enrichmentPass`. The edges are extracted from TS/TSX `class_heritage` nodes via `treeSitterParserDefs.extractClassHeritage`, fed through `ExtractedDefinition.implements` + `extendsClause`, and emitted by `indexingPipelineHeritage.emitHeritageEdges` after both node and edge phases complete (FK-safe via Wave 19 two-phase pattern). Heritage edges with unresolved targets (e.g., `implements EventEmitter` from `node:events`) are SKIPPED, mirroring `callResolutionPass.filterEdges`. Other OO languages (Java, Python, C++, Rust, Go) are out of scope until a separate wave adds them.
- **Test file pattern** in `testDetectPass` is `\.(test|spec|_test|_spec)\.[^.]+$` — matches `foo.test.ts`, `foo.spec.py`, `foo_test.go`, etc. Files not matching this pattern are skipped entirely.
- **`typescriptEnrichmentPass` (Pass 6) — refresh stale-node trap.** `sourceFile.refreshFromFileSystem()` forgets ALL child AST nodes. Any node reference obtained before the refresh becomes invalid after it. The pass's async refresh step runs first (outside any transaction), then all AST navigation (getDescendantsOfKind, etc.) happens after refresh in the synchronous upgrade loop. Never cache `Node` objects across the `refreshFromFileSystem()` boundary.
- **`typescriptEnrichmentPass` — D5.1 authoritative-but-guarded supersession.** Per (source, edgeType): build resolved target set R from ts-morph. If R is non-empty → `deleteOutboundEdgesOfType(project, sourceQn, type)` then insert R. If R is empty → skip the delete (don't wipe valid tree-sitter edges). For CALLS/ASYNC_CALLS: `sourceQn` = enclosing-function QN (function-level). For TYPEOF_REFERENCES: `sourceQn` = whole-file QN (file-level, matching the regex pass's source model). Known limitation: when ts-morph resolves *some* but not all sites in a file, the bulk delete drops tree-sitter edges for unresolved sites — acceptable given the spike's 100% resolution rate.
- **`typescriptEnrichmentPass` — TYPEOF_REFERENCES source model.** `source_id` for TYPEOF_REFERENCES edges is the **whole-file QN** (`project.src.myModule`), NOT an enclosing function QN. This mirrors `indexingPipelineTypeofResolution.ts` exactly (line 210, 224) so the supersession key aligns. The edge FK constraint requires a node with that `id` to exist — in production, `structurePass` creates `File` nodes satisfying this; in tests, insert a `File` node explicitly.
- **`typescriptEnrichmentPass` — TYPEOF detection via TypeQuery AST nodes.** TypeQuery (`ts.SyntaxKind.TypeQuery`, kind 187) is the TS AST node for `typeof X` in any type position. It covers all 6 regex patterns (plain `typeof`, `ReturnType<typeof>`, `Parameters<typeof>`, `InstanceType<typeof>`, `Awaited<ReturnType<typeof>>`, `keyof typeof`) in a single AST enumeration. Resolution: `typeQuery.getExprName().getSymbol().getAliasedSymbol().getDeclarations()[0]`.
- **`typescriptEnrichmentPass` — incremental wiring (D7).** Changed files: `refreshFromFileSystem()` in the async pre-step reads current disk content. New files: `addSourceFileAtPath()` in the same pre-step registers them. Deleted/pruned files: the worker's `onFilePruned` callback calls `tsMorphProject.getSourceFile(path)?.forget()`, releasing the AST from the language-service heap. Cross-file incoming-edge staleness on unchanged files is a documented limitation — cleared by full reindex.
- **`tsMorphProjectFailed` / `tsMorphProjectUnavailable` are terminal for the worker lifetime.** If the ts-morph Project constructor throws or no tsconfig is found, `getOrInitTsMorphProject` returns null on all subsequent runs without retrying. The operator must restart the worker to recover. Both flags reset in `disposeResources()`.
- **`typescriptEnrichmentPass` — regex typeof pass (Pass 5.5) is RETAINED (D6).** `indexingPipelineTypeofResolution.ts` runs as Pass 5.5 and is the fast-path/base layer for non-TS projects and when `skipTsEnrichment` is set. Pass 6 upgrades its edges to the correct target at 0.98/`compiler_api` but does not subsume it.
- **`referencesPass` (Pass 7) — source is function-level, deduped.** `source_id` = enclosing function/method/class QN (same scheme as CALLS). Multiple references from one function to one type produce exactly ONE REFERENCES edge. This bounds edge-count growth vs. emitting one edge per TypeReference node.
- **`referencesPass` — no supersession.** REFERENCES is a new edge type with no tree-sitter base. Re-indexing a file reuses `INSERT OR REPLACE` idempotency on the UNIQUE(source_id, target_id, type) triplet — no `deleteOutboundEdgesOfType` call needed.
- **`referencesPass` — blast-radius participation.** `collectInboundNeighbours` in `graphDatabaseSession.ts` calls `getInboundEdges(id)` with no edge-type filter, so REFERENCES edges are followed automatically. No traversal changes required.
- **`referencesPass` — no second refresh.** Pass 7 runs after Pass 6 on the same `Project` instance. Pass 6 already called `refreshFromFileSystem()` for every file in `indexedFiles`. Pass 7 reads the already-refreshed AST directly.
- **`referencesPass` — JSX intrinsics filtered.** Tags whose first character is lowercase (e.g. `div`, `span`) are HTML intrinsics and are skipped. Only PascalCase or `_`-prefixed tags (project-defined components) are resolved.
- **`referencesPass` — decorator class-level source.** Decorators on class declarations have no enclosing function. In that case the decorated class name is used as the source QN (so `@Component` on `class AppComponent` → source = `project.src.app.AppComponent`).
- **`referencesPass` — decorator/CALLS overlap is intentional and benign.** A factory-call decorator (`@Log()`) on a method produces BOTH a CALLS edge (Pass 6 — the factory is called) AND a REFERENCES edge (Pass 7 — the method references the decorator symbol). Both are semantically true; blast-radius deduplicates nodes by ID so the overlap does not inflate results.

## Dependencies

- **Consumed by**: `graphIndexing.ts` / `graphController.ts` — passes are called at the end of each full or incremental index run, after `resolveEdgeReferences()` has linked cross-file edges.
- **Reads from**: `GraphDatabase` nodes and edges already in the store.
- **External dependency**: `gitCoChangePass` only — `child_process.execSync` for `git log`.

<!-- claude-md-auto:end -->

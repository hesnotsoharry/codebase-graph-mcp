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
| `HTTP_CALLS` | `httpLinkPass` | Function calls an HTTP endpoint (props: `{ confidence, method }`) |
| `TESTS` | `testDetectPass` | Test function exercises a production function |

## Gotchas

- **`gitCoChangePass` silently no-ops** if `git` is unavailable, not in a git repo, or `git log` fails — `getCommitFiles()` returns `null` on any exception. This is intentional; non-git repos must not crash indexing.
- **Commits touching >20 files are excluded** (`MAX_FILES_PER_COMMIT`) — large refactors/renames would create O(n²) spurious co-change pairs.
- **`httpLinkPass` confidence scoring** uses method match + caller-name/route-path string similarity. A wildcard `'*'` method pattern always matches but gets a lower base score. Edges below confidence threshold are not created.
- **IMPLEMENTS and EXTENDS edges are emitted from `definitionPass`** (since Wave 21, 2026-05-26), NOT from `enrichmentPass`. The edges are extracted from TS/TSX `class_heritage` nodes via `treeSitterParserDefs.extractClassHeritage`, fed through `ExtractedDefinition.implements` + `extendsClause`, and emitted by `indexingPipelineHeritage.emitHeritageEdges` after both node and edge phases complete (FK-safe via Wave 19 two-phase pattern). Heritage edges with unresolved targets (e.g., `implements EventEmitter` from `node:events`) are SKIPPED, mirroring `callResolutionPass.filterEdges`. Other OO languages (Java, Python, C++, Rust, Go) are out of scope until a separate wave adds them.
- **Test file pattern** in `testDetectPass` is `\.(test|spec|_test|_spec)\.[^.]+$` — matches `foo.test.ts`, `foo.spec.py`, `foo_test.go`, etc. Files not matching this pattern are skipped entirely.

## Dependencies

- **Consumed by**: `graphIndexing.ts` / `graphController.ts` — passes are called at the end of each full or incremental index run, after `resolveEdgeReferences()` has linked cross-file edges.
- **Reads from**: `GraphDatabase` nodes and edges already in the store.
- **External dependency**: `gitCoChangePass` only — `child_process.execSync` for `git log`.

<!-- claude-md-auto:end -->

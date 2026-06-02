---
vendor: ts-morph
sdkVersion: "28.0.0"
firstWritten: 2026-06-02
lastVerified: 2026-06-02
relatedPaths:
  - src/passes/typescriptEnrichmentPass.ts
  - src/passes/referencesPass.ts
  - src/indexingWorker.ts
notes: TypeScript Compiler API wrapper; bundles own TS version; requires careful lifecycle/memory management and path normalization on Windows.
---

# ts-morph gotchas

## 2026-06-02 — Bundled TypeScript version must match or exceed project's TS

Source: wave-2, commit 9f1e2c5 (Phase 0 spike)

**Gotcha:** ts-morph vendors its own TypeScript inside `@ts-morph/common` — it is NOT listed in `npm view ts-morph dependencies` as a visible peer/dev dependency. ts-morph@28.0.0 bundles TypeScript **6.0.2**. If the bundled TS version is older than the project's TS, the type-checker will silently resolve newer syntax to `any`, losing precision.

**Workaround:** At runtime, import `ts` directly from the "ts-morph" package, **not** from the standalone "typescript" package. Query the bundled version: `import { ts } from 'ts-morph'; const version = ts.version;`. Verify bundled TS ≥ repo TS on cold-start (Wave 2 Phase 0 spiked this: bundled 6.0.2 ≥ repo 5.7.2 ✓). Do NOT import `ts` from "typescript" separately — that creates a dual-TS environment where the compiler sees the wrong version.

**Why:** ts-morph's internal type-checking uses only the bundled `ts`. An external standalone "typescript" import in your code is decoupled from ts-morph's compiler instance and will produce stale/unsafe type info.

---

## 2026-06-02 — `refreshFromFileSystem()` forgets all child AST nodes (stale-node trap)

Source: wave-2, commit 9f1e2c5 (Phase 2) — `src/passes/typescriptEnrichmentPass.ts:30-38`

**Gotcha:** When you call `await sourceFile.refreshFromFileSystem()` to re-load a file from disk, ts-morph discards ALL child AST node references — any `CallExpression`, `Identifier`, `Declaration`, or nested node you cached before the refresh becomes invalid (dangling pointers). Accessing them after refresh returns stale data or throws.

**Workaround:** Separate the async refresh from the synchronous AST walk. (1) Run ALL `refreshFromFileSystem()` calls first, outside any database transaction (async pre-step). (2) Then navigate the AST fresh using `getDescendantsOfKind()`, `getChildAtIndex()`, etc. — do NOT cache node references across the refresh boundary. See `typescriptEnrichmentPass.ts` for the pattern: async pre-step handles refresh, then the chunked synchronous loop (inside transactions) does all AST navigation.

**Why:** ts-morph's language-service heap drops all node metadata on refresh to keep memory consistent with the disk state. The API does not track which nodes are stale — it assumes you start fresh after a refresh.

---

## 2026-06-02 — `getFilePath()` returns forward-slash absolute paths even on Windows; path comparisons must normalize

Source: wave-2, commit 9f1e2c5 (Phase 2) — `src/passes/typescriptEnrichmentPass.ts` (line ~180-190 observed during testing)

**Gotcha:** `sourceFile.getFilePath()` always returns forward-slash-separated absolute paths (`C:/projects/my-repo/src/index.ts`), even on Windows (where the filesystem uses backslashes). When comparing file paths for prefix matching, de-duplication, or `getSourceFile(path)` lookups, a missed backslash → forward-slash normalization silently fails: `getSourceFile()` returns `undefined`, edges are not resolved, memory leaks because `forget()` never fires.

**Workaround:** (1) Normalize all file paths to forward slashes before comparison or lookup: `path.normalize(filePath).replace(/\\/g, '/')`. (2) For path-prefix comparisons (e.g., "is this file in the project?"), use case-insensitive matching on Windows (`C:` vs `c:` can diverge). (3) When you need to store or compare relative paths, normalize immediately after extracting from `getFilePath()`.

**Why:** Node.js path methods (`.dirname()`, `.join()`) on Windows use backslashes; ts-morph internally normalizes to forward slashes for cross-platform compatibility, but the contract is not documented. Missed normalizations silently no-op instead of throwing an error, making them hard to debug.

---

## 2026-06-02 — Resolution chain for following re-exports and type references

Source: wave-2, commit 9f1e2c5 (Phase 2) — `src/passes/typescriptEnrichmentPass.ts:220-250 (CALLS pattern); referencesPass.ts:70-120 (TYPEOF/REFERENCES pattern)`

**Gotcha:** Resolving a call site or type reference through re-exports (barrel files, aliased imports, `typeof X`) requires a specific AST-walking chain. Using the wrong method or skipping steps loses the barrel and resolves to the re-export stub instead of the real definition.

**Workaround:** 
- **For CALLS/ASYNC_CALLS:** `getTypeChecker().getResolvedSignature(callExpression)?.getDeclaration()` — resolves the call's target declaration, following re-exports automatically.
- **For type-only identifiers in TYPEOF / type annotations:** `identifier.getSymbol()?.getAliasedSymbol()?.getDeclarations()[0]` — walks from the identifier node through its symbol to the aliased target, then fetches the first declaration.
- **For `typeof X` in type position (TypeQuery nodes):** `typeQuery.getExprName().getSymbol().getAliasedSymbol().getDeclarations()[0]` — navigates the `typeof` operator to the referenced expression, then follows its symbol.

See `typescriptEnrichmentPass.ts` lines 220–250 for the CALLS pattern and `referencesPass.ts` lines 70–120 for the TYPEOF/REFERENCES pattern.

**Why:** Direct `.getSymbol()` without `.getAliasedSymbol()` stops at the re-export; re-export modules (barrels, index.ts) would be captured as the target instead of the true definition.

---

## 2026-06-02 — Worker memory ceiling; Project holds full language-service heap (500MB–1GB on large repos)

Source: wave-2, decisions D2/D3 — `src/indexingWorker.ts:39-98`

**Gotcha:** A ts-morph `Project` instance retains the entire TypeScript language-service heap in memory — for large repositories (500+ files, especially with deep type hierarchies), this can be 500MB–1GB additive to the tree-sitter parser's memory. Creating a new `Project` per run or per file would multiply this; a single worker thread cannot tolerate it on CPU-constrained boxes (embedded graphs, CI runners).

**Workaround:** (1) Create the `Project` **once per worker-thread lifetime** and cache it (singleton pattern in `indexingWorker.ts`). (2) For incremental runs, call `sourceFile.refreshFromFileSystem()` for changed files and `project.addSourceFileAtPath()` for new ones instead of re-constructing. (3) **Provide an operator escape-valve:** add a `skipTsEnrichment?: boolean` flag (threaded through `IndexingOptions` and `IndexRequestOptions`) — when set, `getOrInitTsMorphProject` returns `null` and the entire pass is a no-op. (4) Cache the "unavailable" outcome: if ts-morph init fails or no `tsconfig.json` exists, set a flag (`tsMorphProjectFailed` / `tsMorphProjectUnavailable`) and never retry on that worker (a retry loop would re-init the heavy heap on every run).

**Why:** The language-service heap is needed for type-checking, resolution, and symbol navigation — you cannot skip it if you want precision. The singleton + warm-update pattern amortizes the cost. The skip flag is the safety valve for operators who cannot afford the memory in their environment.

---

## 2026-06-02 — `deleteOutboundEdgesOfType()` must be project-scoped, not global; prevents nuke of correct external-package edges

Source: wave-2, decision D5 — `src/graphDatabaseHelpers.ts:42` (`deleteOutboundEdgesOfType` method)

**Gotcha:** When ts-morph resolves a call to a *different target* than tree-sitter did (e.g., following a barrel re-export), the `(source_id, target_id, type)` triplet differs. The simple `INSERT OR REPLACE` strategy would not remove the wrong edge — it only replaces exact triplet matches. If you use a naive bulk delete of all outbound edges of a type from a source (e.g., `DELETE FROM edges WHERE source_id = ? AND type = ?`), you risk nuking correct edges to external packages, imported libraries, or other intra-project references that tree-sitter correctly resolved.

**Workaround:** When deleting superseded edges, **scope the delete to the project boundary**: `deleteOutboundEdgesOfType(project, sourceId, type)` which translates to `DELETE FROM edges WHERE project = ? AND source_id = ? AND type = ? ` (WHERE clause includes the `project` column). This ensures you only remove edges whose target is also in the same project (internal edges that ts-morph is re-resolving), not edges to external/non-indexed targets. Verify the `GraphDatabase` schema includes the `project` column on the `edges` table.

**Why:** External dependencies (npm packages, imported types from outside the indexed set) are not re-resolved by ts-morph (it only handles local files). Removing those edges would lose information. Project-scoped delete prevents the accidental nuke.

---

## 2026-06-02 — Memory cache: is ts-morph unavailable or failed? Both terminal for worker lifetime; restart worker to recover

Source: wave-2, decision D4 — `src/indexingWorker.ts:42-52, 59-98`

**Gotcha:** If the ts-morph `Project` constructor throws on first initialization OR no `tsconfig.json` exists at the project root, the flags `tsMorphProjectFailed` or `tsMorphProjectUnavailable` are set. On every subsequent run within that worker's lifetime, `getOrInitTsMorphProject()` checks these flags and returns `null` immediately **without retrying**. This prevents retry loops, but it also means a transient initialization error (permission issue, broken tsconfig, missing dependencies) won't self-heal — the only recovery is to restart the worker.

**Workaround:** (1) Ensure `tsconfig.json` exists and is valid before starting the worker. (2) Catch the initialization error at worker startup (or first index run) and log it clearly with the error message. (3) Document to the operator that `skipTsEnrichment: true` is a temporary workaround, and a full worker restart is needed to retry. (4) In tests, reset both flags in `disposeResources()` or the test teardown (so each test run re-initializes), or mock `getOrInitTsMorphProject` to return a fresh Project.

**Why:** The terminal flag prevents pathological retry loops that would repeatedly allocate the 500MB+ heap on every run. The cost is that recovery requires an external restart.

---

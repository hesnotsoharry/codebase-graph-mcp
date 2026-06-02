/**
 * typescriptEnrichmentPass.ts — Pass 6: type-aware CALLS/ASYNC_CALLS/TYPEOF_REFERENCES resolution.
 *
 * Supersedes tree-sitter edges with compiler-resolved edges at 0.98 / compiler_api
 * when ts-morph can definitively identify the callee/referenced-type declaration
 * (including barrel re-exports, overloaded names, aliased imports).
 *
 * Design decisions honored:
 *   D1   — Pass 6, after typeofResolutionPass (5.5), before runEnrichmentPasses.
 *   D3   — ts-morph Project may be null (skip flag or no tsconfig) → no-op.
 *   D5.1 — Authoritative-but-guarded supersession: per (source, edgeType),
 *           build resolved target set R; if R non-empty → delete-then-insert;
 *           if R empty → skip delete (don't wipe good tree-sitter edges).
 *   D6   — Regex typeof pass (Pass 5.5) is RETAINED as the fast-path/base layer;
 *           this pass UPGRADES TYPEOF_REFERENCES to the correct target at 0.98.
 *   D7   — Incremental: changed files → refreshFromFileSystem (done in async
 *           pre-step); new files → addSourceFileAtPath (in same pre-step);
 *           deleted/pruned files → tsMorphProject.getSourceFile(path).forget()
 *           (wired in worker's onFilePruned callback, Phase 1). Cross-file
 *           incoming-edge staleness on unchanged files is a documented limitation
 *           cleared by full reindex.
 *
 * TYPEOF_REFERENCES source/target model (mirrors indexingPipelineTypeofResolution.ts):
 *   source_id = fileQn  (whole-file QN — e.g. "project.src.myModule")
 *   target_id = any indexed node QN (Function/Method/Class/Variable/Interface/Type/Enum)
 *               whose name matches the referenced type symbol.
 *   This matches the regex pass's file-level granularity exactly (line 210+224
 *   of indexingPipelineTypeofResolution.ts) so supersession aligns correctly.
 *
 * Stale-node trap:
 *   `sourceFile.refreshFromFileSystem()` forgets all child AST nodes. All
 *   per-file navigation MUST happen AFTER the refresh, never before.
 *   Do not cache any AST node references across the refresh boundary.
 *
 * Incremental limitation (documented, not a bug):
 *   Only files in `indexedFiles` (the changed set) are re-resolved. Edges
 *   from unchanged files into a changed file are not re-resolved. Cleared by
 *   full reindex.
 */
import type { GraphDatabase } from '../graphDatabase';
import type { IndexedFile } from '../indexingPipelineTypes';
import { Project } from 'ts-morph';
/**
 * Build the whole-file qualified-name.
 * Scheme: `${projectName}.${relativePath.replace(/\//g,'.').replace(/\.[^.]+$/,'')}`
 * Mirrors indexingPipelineCallResolution.ts:140 and
 * indexingPipelineTypeofResolution.ts:185.
 *
 * Exported so referencesPass.ts can reuse without duplication.
 */
export declare function buildFileQn(projectName: string, relativePath: string): string;
/**
 * Build the qualified-name for a named symbol inside a file.
 * Scheme: `${fileQn}.${symbolName}`
 *
 * Exported so referencesPass.ts can reuse without duplication.
 */
export declare function buildSymbolQn(fileQn: string, symbolName: string): string;
/**
 * Given an absolute file path (forward slashes from ts-morph) and the project
 * root (may use backslashes on Windows), return the relative path with forward
 * slashes, or null if the file is outside the project.
 *
 * Case-insensitive prefix comparison handles Windows drive-letter case
 * differences (C:/ vs c:/) between ts-morph's getFilePath() and projectRoot.
 * Slices from the original normFile to preserve real casing in the result.
 *
 * Exported so referencesPass.ts can reuse without duplication.
 */
export declare function absoluteToRelative(absoluteFilePath: string, projectRoot: string): string | null;
/**
 * Walk the ancestor chain of a node to find the nearest enclosing named
 * function or method and return its name. Returns null if none found.
 *
 * Mirrors the tree-sitter pass's enclosingDef lookup so caller QN aligns.
 *
 * Exported so referencesPass.ts can reuse without duplication.
 */
export declare function getEnclosingFunctionName(node: import('ts-morph').Node): string | null;
export interface TsEnrichmentPassOptions {
    /**
     * The ts-morph Project singleton from the worker, or null when:
     *  - skipTsEnrichment is set
     *  - no tsconfig.json exists at projectRoot
     *  - the Project constructor previously threw (tsMorphProjectFailed)
     */
    tsMorphProject: Project | null;
}
/**
 * Pass 6 — ts-morph type-aware CALLS/ASYNC_CALLS/TYPEOF_REFERENCES resolution.
 *
 * Signature mirrors typeofResolutionPass (Pass 5.5) plus a tsMorphProject param.
 * The pipeline threads the Project from the worker singleton.
 *
 * When tsMorphProject is null → immediate no-op (D3/D4 skip paths).
 *
 * Incremental wiring (D7):
 *   changed files → refreshFromFileSystem() in async pre-step (below)
 *   new files     → addSourceFileAtPath() in async pre-step (below)
 *   deleted files → worker's onFilePruned callback calls getSourceFile().forget()
 *                   (wired in indexingWorker.ts handleIndexRepository, Phase 1)
 */
export declare function typescriptEnrichmentPass(db: GraphDatabase, projectName: string, projectRoot: string, indexedFiles: IndexedFile[], options: TsEnrichmentPassOptions): Promise<void>;
//# sourceMappingURL=typescriptEnrichmentPass.d.ts.map
/**
 * referencesPass.ts — Pass 7: first-class REFERENCES edges for blast-radius completeness.
 *
 * Captures symbol references that CALLS and TYPEOF_REFERENCES miss:
 *   - Type-only references: a symbol used in a type annotation / param type /
 *     return type / extends-implements / generic arg — but never called.
 *   - Decorator uses: `@Component(...)` — the decorator name is a reference.
 *   - JSX element uses: `<MyComponent/>` — the tag name is a reference.
 *
 * Source model: FUNCTION-LEVEL (enclosing function/method/class QN), matching
 * the CALLS/ASYNC_CALLS model. This bounds edge-count growth — N type
 * references from one function to one type produce ONE edge (deduped).
 *
 * No tree-sitter base layer for REFERENCES (new edge type) → no supersession
 * delete needed. Idempotency is provided by INSERT OR REPLACE on the
 * UNIQUE(source_id, target_id, type) constraint.
 *
 * Blast-radius: `collectInboundNeighbours` in graphDatabaseSession.ts calls
 * `getInboundEdges()` with no edge-type filter, so REFERENCES edges are
 * followed automatically without any traversal changes.
 *
 * Incremental: Pass 7 runs after Pass 6 on the same Project instance. Pass 6
 * already called refreshFromFileSystem() for every file in indexedFiles, so
 * the AST is already fresh. No second refresh needed.
 *
 * Node kinds enumerated:
 *   TypeReference  — type annotations, param types, return types, extends/implements,
 *                    generic args (excludes `typeof` — that is TypeQuery/TYPEOF_REFERENCES)
 *   Decorator      — `@Name` and `@Name(...)` — the outer identifier is the reference
 *   JsxOpeningElement + JsxSelfClosingElement — JSX tag names
 *
 * Excluded from TypeReference processing:
 *   - TypeQuery nodes (`typeof X`) — handled by TYPEOF_REFERENCES in Pass 5.5/6
 *   - Built-in / lib types (string, number, Promise, etc.) — filtered by validNodeIds
 */
import type { GraphDatabase } from '../graphDatabase';
import type { IndexedFile } from '../indexingPipelineTypes';
import { Project } from 'ts-morph';
export interface ReferencesPassOptions {
    /**
     * The ts-morph Project singleton from the worker (same instance as Pass 6).
     * Pass 6 already called refreshFromFileSystem() on indexed files — no second
     * refresh needed here; the AST is already current.
     * Null when skipTsEnrichment / no tsconfig / prior failure → no-op.
     */
    tsMorphProject: Project | null;
}
/**
 * Pass 7 — first-class REFERENCES edges for blast-radius completeness.
 *
 * Enumerates type-only references, decorator uses, and JSX element uses that
 * CALLS and TYPEOF_REFERENCES miss. Source is function-level (enclosing
 * function/method/class QN). Deduped per (sourceQn, targetQn).
 *
 * No-op when tsMorphProject is null.
 * TS/TSX files only.
 */
export declare function referencesPass(db: GraphDatabase, projectName: string, projectRoot: string, indexedFiles: IndexedFile[], options: ReferencesPassOptions): Promise<void>;
//# sourceMappingURL=referencesPass.d.ts.map
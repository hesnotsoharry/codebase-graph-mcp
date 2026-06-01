/**
 * indexingPipelineHeritage.ts — Wave 21 Phase 1: IMPLEMENTS + EXTENDS edge helpers.
 *
 * Extracted from indexingPipelinePasses.ts to keep that file under the 300-line limit.
 * Called by `definitionPass` after the node-phase completes so all FK targets exist.
 *
 * Decision summary (from wave-21-decisions.md):
 *   - Decision 2: edge emission in `definitionPass`, not `enrichmentPass`.
 *   - Decision 4: skip edges whose target_id doesn't resolve in symbolsByName
 *     (mirrors Wave 19 callResolutionPass filterEdges safety net).
 *   - Decision 5: emit both IMPLEMENTS and EXTENDS from the same class_heritage walk.
 */
import type { GraphDatabase } from './graphDatabase';
import type { IndexedFile } from './indexingPipelineTypes';
/**
 * Build a name → qualifiedId[] map covering Class and Interface nodes.
 * IMPLEMENTS targets are Interface nodes; EXTENDS targets are Class nodes.
 * Mirrors callResolutionPass.buildSymbolsByName but scoped to heritage target labels.
 */
export declare function buildHeritageSymbols(db: GraphDatabase, projectName: string): Map<string, string[]>;
/**
 * Post-node-phase: build symbolsByName from DB, collect IMPLEMENTS+EXTENDS edges,
 * and insert via db.insertEdges. Called by `definitionPass` in both chunked and
 * non-chunked paths after all symbol nodes are committed — guarantees FK safety.
 * Emits `[trace:definitionPass.heritage]` log line per project per index run.
 */
export declare function emitHeritageEdges(db: GraphDatabase, projectName: string, indexedFiles: IndexedFile[]): void;
//# sourceMappingURL=indexingPipelineHeritage.d.ts.map
/**
 * indexingPipelineTypeofResolution.ts — Pass 5.5: typeof / ReturnType edge resolution.
 *
 * Scans TypeScript source files for `typeof X` / `ReturnType<typeof X>` and similar
 * type-level references, emitting TYPEOF_REFERENCES edges in the graph.
 *
 * Captures all 6 typeof patterns from ADR D3:
 *   - typeof X
 *   - ReturnType<typeof X>
 *   - Parameters<typeof X>
 *   - InstanceType<typeof X>
 *   - Awaited<ReturnType<typeof X>>
 *   - keyof typeof X
 *
 * NOTE ON APPROACH: The tree-sitter parser (`treeSitterParser.ts`) frees its
 * parse tree immediately after extraction (see `tree.delete()` in parseFile's
 * `finally` block). The tree is not stored on `ParsedFileResult`. Rather than
 * re-parsing files or modifying the parser, this pass scans source text with
 * regex patterns anchored to the 6 typeof patterns. The patterns are syntactically
 * distinctive in TypeScript type positions and won't appear as valid value-level code.
 *
 * TypeScript-only: typeof in type position has no meaning in plain JS / JSX — skip
 * non-TypeScript files (.ts and .tsx only).
 *
 * Unresolved targets: when the referenced symbol name cannot be resolved to a
 * known node ID (e.g. external lib not in graph), the edge is skipped. This
 * matches callResolutionPass behavior.
 */
import type { GraphDatabase } from './graphDatabase';
import type { IndexedFile } from './indexingPipelineTypes';
/**
 * The 6 typeof patterns from ADR D3.
 */
export type TypeofPattern = 'typeof' | 'ReturnType<typeof>' | 'Parameters<typeof>' | 'InstanceType<typeof>' | 'Awaited<ReturnType<typeof>>' | 'keyof typeof';
export interface TypeofSite {
    symbolName: string;
    startLine: number;
    pattern: TypeofPattern;
    context: string;
}
export declare function typeofResolutionPass(db: GraphDatabase, projectName: string, _projectRoot: string, indexedFiles: IndexedFile[]): void;
//# sourceMappingURL=indexingPipelineTypeofResolution.d.ts.map
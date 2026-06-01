/**
 * graphControllerCompatAdapters.ts — Shape translators between System 2 types
 * and System 1 (GraphController) return types.
 *
 * Every public function here is a pure transformer: no side-effects, no DB
 * calls, no logging. Consumers call these to convert System 2 results into
 * the shapes expected by existing callers of GraphController.
 */
import type { ChangedSymbol } from './detectChangesForSessionTypes';
import type { GraphEdge as S2GraphEdge, GraphNode as S2GraphNode } from './graphDatabaseTypes';
import type { ArchitectureView, CallPathResult, ChangeDetectionResult, CodeSnippetResult, GraphEdge, GraphNode, GraphSchema, SearchResult } from './graphTypes';
import type { ArchitectureResult, DetectChangesResult, GraphSchemaResult, TraceResult } from './queryEngineTypes';
/**
 * System 1 ID format: `{relativePath}::{symbolName}::{type}::{lineNumber}`
 * System 2 ID format: qualified_name, which is the node's `id` column.
 *
 * S2 qualified_name is opaque — no guaranteed structure shared with S1.
 * Strategy (a): translate on input (consumer keeps S1 IDs), translate on output.
 *
 * Round-trip: toSystem2NodeId(toSystem1NodeId(s2Node)) == s2Node.id
 * because toSystem1NodeId embeds the S2 id in metadata, and toSystem2NodeId
 * extracts it. If the S1 id was constructed externally (not from a S2 node),
 * we fall back to treating the whole string as the S2 id.
 */
export declare function toSystem1NodeId(s2Node: S2GraphNode): string;
/**
 * Extract the System 2 node id from a System 1 node id that was produced
 * by toSystem1NodeId. If the id is not in S1 format, treat it as a S2 id
 * directly (allows callers to pass S2 ids through unchanged).
 */
export declare function toSystem2NodeId(s1Id: string, _projectName: string): string;
export declare function toSystem1GraphNode(s2Node: S2GraphNode): GraphNode;
export declare function toSystem1GraphEdge(s2Edge: S2GraphEdge, s2Nodes: Map<string, S2GraphNode>): GraphEdge;
export declare function toSystem1SearchResult(s2Node: S2GraphNode, query: string): SearchResult;
export declare function toSystem1CallPathResult(traceResult: TraceResult, toName: string): CallPathResult;
export declare function toSystem1ArchitectureView(result: ArchitectureResult): ArchitectureView;
export declare function toSystem1ChangeDetectionResult(result: DetectChangesResult): ChangeDetectionResult;
export declare function toSystem1ChangeDetectionResultFromSession(result: {
    changedFiles: string[];
    affectedSymbols: ChangedSymbol[];
    blastRadius: number;
}): ChangeDetectionResult;
export declare function toSystem1GraphSchema(result: GraphSchemaResult): GraphSchema;
export declare function toSystem1CodeSnippetResult(content: string, node: S2GraphNode, depIds: string[], dependentIds: string[]): CodeSnippetResult;
//# sourceMappingURL=graphControllerCompatAdapters.d.ts.map
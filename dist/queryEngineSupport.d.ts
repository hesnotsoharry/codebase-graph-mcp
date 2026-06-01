/**
 * queryEngineSupport.ts — Helper functions extracted from queryEngine.ts
 * to keep the main file under the max-lines / max-lines-per-function limits.
 */
import type { GraphDatabase } from './graphDatabase';
import type { EdgeType, GraphNode } from './graphDatabaseTypes';
import type { ChangedFileInfo, ChangedSymbol, CodeSearchOptions, CodeSearchResult, DetectChangesOptions, ImpactedCaller, RiskLevel, TraceEdge, TraceNode, TraceResult } from './queryEngineTypes';
export declare const MAX_BFS_NODES = 200;
export declare const MAX_DEPTH = 5;
export declare const CALL_EDGE_TYPES: EdgeType[];
export declare const SYMBOL_LABELS: readonly ["Function", "Method", "Class", "Interface", "Type", "Enum"];
export declare function collectTraceEdges(pathNodes: string[], traceEdges: TraceEdge[]): void;
export declare function classifyRisk(db: GraphDatabase, node: GraphNode, depth: number): RiskLevel;
export declare function getNodeSignature(node: GraphNode): string | null;
export declare function deduplicateTraceResult(result: TraceResult): TraceResult;
export declare function buildImpactSummary(riskCounts: Record<RiskLevel, number>): string;
export declare function buildChangedSymbols(db: GraphDatabase, projectName: string, changedFiles: ChangedFileInfo[]): ChangedSymbol[];
interface ImpactedCallersOptions {
    db: GraphDatabase;
    changedSymbols: ChangedSymbol[];
    clampedDepth: number;
    classifyFn: (node: GraphNode, depth: number) => RiskLevel;
    minConfidence?: number;
}
export declare function buildImpactedCallers({ db, changedSymbols, clampedDepth, classifyFn, minConfidence, }: ImpactedCallersOptions): ImpactedCaller[];
export declare function getGitChangedFiles(options: DetectChangesOptions, projectRoot: string): Promise<ChangedFileInfo[]>;
export declare function searchCodeFiles(db: GraphDatabase, projectName: string, projectRoot: string, options: CodeSearchOptions): {
    results: CodeSearchResult[];
    total: number;
    hasMore: boolean;
};
export declare function buildRiskSummaryFromNodes(nodes: TraceNode[]): string;
export declare function buildLayerMap(db: GraphDatabase, projectName: string): Record<string, string[]>;
export {};
//# sourceMappingURL=queryEngineSupport.d.ts.map
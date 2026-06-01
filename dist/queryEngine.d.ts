/**
 * queryEngine.ts — High-level query operations over the codebase graph.
 *
 * Provides BFS call-path tracing with risk classification, git-aware impact
 * analysis (blast radius), architecture overview computation, schema
 * introspection, grep-like code search, and source snippet retrieval.
 */
import type { GraphDatabase } from './graphDatabase';
import { searchCodeFiles, SYMBOL_LABELS } from './queryEngineSupport';
import type { ArchitectureAspect, ArchitectureResult, CodeSearchOptions, DetectChangesOptions, DetectChangesResult, GraphSchemaResult, TraceCallPathOptions, TraceResult } from './queryEngineTypes';
export declare class QueryEngine {
    private db;
    private projectName;
    private projectRoot;
    constructor(db: GraphDatabase, projectName: string, projectRoot: string);
    traceCallPath(options: TraceCallPathOptions): TraceResult;
    private resolveStartNode;
    private collectBfsResults;
    private runTraceDirection;
    detectChanges(options: DetectChangesOptions): Promise<DetectChangesResult>;
    getArchitecture(aspects: ArchitectureAspect[]): ArchitectureResult;
    getGraphSchema(): GraphSchemaResult;
    searchCode(options: CodeSearchOptions): {
        results: ReturnType<typeof searchCodeFiles>['results'];
        total: number;
        hasMore: boolean;
    };
    getCodeSnippet(qualifiedName: string): string | null;
    private computeLanguages;
    private computePackages;
    private computeEntryPoints;
    private computeRoutes;
    private computeHotspots;
    private computeFileTree;
    private computeLayers;
}
export { SYMBOL_LABELS };
//# sourceMappingURL=queryEngine.d.ts.map
import type { NodeLabel } from './graphDatabaseTypes';
export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export interface TraceCallPathOptions {
    functionName: string;
    direction: 'inbound' | 'outbound' | 'both';
    depth: number;
    riskLabels: boolean;
    minConfidence?: number;
}
export interface TraceNode {
    id: string;
    name: string;
    label: NodeLabel;
    filePath: string | null;
    startLine: number | null;
    signature: string | null;
    depth: number;
    risk?: RiskLevel;
}
export interface TraceEdge {
    source: string;
    target: string;
    type: string;
}
export interface TraceResult {
    startNode: TraceNode;
    nodes: TraceNode[];
    edges: TraceEdge[];
    totalNodes: number;
    truncated: boolean;
    impactSummary?: string;
}
export type ChangeScope = 'unstaged' | 'staged' | 'all' | 'branch';
export interface DetectChangesOptions {
    scope: ChangeScope;
    baseBranch?: string;
    depth: number;
    minConfidence?: number;
}
export interface ChangedSymbol {
    name: string;
    label: NodeLabel;
    filePath: string;
    qualifiedName: string;
}
export interface ImpactedCaller {
    name: string;
    label: NodeLabel;
    filePath: string | null;
    qualifiedName: string;
    depth: number;
    risk: RiskLevel;
}
export interface ChangedFileInfo {
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
}
export interface DetectChangesResult {
    changedFiles: ChangedFileInfo[];
    changedSymbols: ChangedSymbol[];
    impactedCallers: ImpactedCaller[];
    riskSummary: Record<RiskLevel, number>;
}
export type ArchitectureAspect = 'languages' | 'packages' | 'entry_points' | 'routes' | 'hotspots' | 'boundaries' | 'services' | 'layers' | 'clusters' | 'file_tree' | 'adr' | 'all';
export interface ArchitectureResult {
    projectName: string;
    aspects: Record<string, string>;
}
export interface GraphSchemaResult {
    nodeLabelCounts: Record<string, number>;
    edgeTypeCounts: Record<string, number>;
    relationshipPatterns: string[];
    sampleNames: {
        functions: string[];
        classes: string[];
        qualifiedNames: string[];
    };
}
export interface CodeSearchResult {
    filePath: string;
    lineNumber: number;
    lineContent: string;
    matchStart: number;
    matchEnd: number;
}
export interface CodeSearchOptions {
    pattern: string;
    filePattern?: string;
    regex?: boolean;
    caseSensitive?: boolean;
    maxResults?: number;
    offset?: number;
}
//# sourceMappingURL=queryEngineTypes.d.ts.map
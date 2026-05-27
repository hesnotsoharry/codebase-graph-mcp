import type { NodeLabel } from './graphDatabaseTypes';

// ─── Trace call path ─────────────────────────────────────────────────────────

export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface TraceCallPathOptions {
  functionName: string; // Exact name match
  direction: 'inbound' | 'outbound' | 'both';
  depth: number; // 1-5
  riskLabels: boolean; // Include risk classification
  minConfidence?: number; // 0.0–1.0; default 0 (no filtering)
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
  truncated: boolean; // True if hit 200-node cap
  impactSummary?: string; // When riskLabels = true
}

// ─── Detect changes ──────────────────────────────────────────────────────────

export type ChangeScope = 'unstaged' | 'staged' | 'all' | 'branch';

export interface DetectChangesOptions {
  scope: ChangeScope;
  baseBranch?: string; // For branch scope
  depth: number; // BFS depth for blast radius (1-5)
  minConfidence?: number; // 0.0–1.0; default 0 (no filtering)
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

// ─── Architecture ────────────────────────────────────────────────────────────

export type ArchitectureAspect =
  | 'languages'
  | 'packages'
  | 'entry_points'
  | 'routes'
  | 'hotspots'
  | 'boundaries'
  | 'services'
  | 'layers'
  | 'clusters'
  | 'file_tree'
  | 'adr'
  | 'all';

export interface ArchitectureResult {
  projectName: string;
  aspects: Record<string, string>; // aspect name -> formatted text
}

// ─── Graph schema ────────────────────────────────────────────────────────────

export interface GraphSchemaResult {
  nodeLabelCounts: Record<string, number>;
  edgeTypeCounts: Record<string, number>;
  relationshipPatterns: string[];
  sampleNames: { functions: string[]; classes: string[]; qualifiedNames: string[] };
}

// ─── Search code ─────────────────────────────────────────────────────────────

export interface CodeSearchResult {
  filePath: string;
  lineNumber: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
}

export interface CodeSearchOptions {
  pattern: string;
  filePattern?: string; // Glob-like filter
  regex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number; // Default 100
  offset?: number;
}

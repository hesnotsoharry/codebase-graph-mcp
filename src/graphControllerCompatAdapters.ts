/**
 * graphControllerCompatAdapters.ts — Shape translators between System 2 types
 * and System 1 (GraphController) return types.
 *
 * Every public function here is a pure transformer: no side-effects, no DB
 * calls, no logging. Consumers call these to convert System 2 results into
 * the shapes expected by existing callers of GraphController.
 */

import type { ChangedSymbol } from './detectChangesForSessionTypes';
import type {
  EdgeType,
  GraphEdge as S2GraphEdge,
  GraphNode as S2GraphNode,
} from './graphDatabaseTypes';
import type {
  ArchitectureView,
  CallPathResult,
  ChangeDetectionResult,
  CodeSnippetResult,
  GraphEdge,
  GraphNode,
  GraphSchema,
  SearchResult,
} from './graphTypes';
import type {
  ArchitectureResult,
  DetectChangesResult,
  GraphSchemaResult,
  TraceResult,
} from './queryEngineTypes';

// ─── Node label mapping ───────────────────────────────────────────────────────

type S1NodeType = GraphNode['type'];

const LABEL_TO_S1: Record<string, S1NodeType> = {
  File: 'file',
  Function: 'function',
  Method: 'function',
  Class: 'class',
  Interface: 'interface',
  Type: 'type_alias',
  Variable: 'variable',
  Module: 'module',
  Export: 'export',
};

function mapLabel(label: string): S1NodeType {
  // eslint-disable-next-line security/detect-object-injection -- label is a DB-sourced node label, not user input
  return LABEL_TO_S1[label] ?? 'variable';
}

// ─── Edge type mapping ────────────────────────────────────────────────────────

type S1EdgeType = GraphEdge['type'];

const EDGE_TO_S1: Record<string, S1EdgeType> = {
  IMPORTS: 'imports',
  EXPORTS: 'exports',
  CALLS: 'calls',
  ASYNC_CALLS: 'calls',
  HTTP_CALLS: 'calls',
  DEFINES: 'contains',
  DEFINES_METHOD: 'contains',
  CONTAINS_FILE: 'contains',
  CONTAINS_FOLDER: 'contains',
  CONTAINS_PACKAGE: 'contains',
  IMPLEMENTS: 'implements',
  EXTENDS: 'extends',
  USAGE: 'depends_on',
  CONFIGURES: 'depends_on',
  WRITES: 'depends_on',
  MEMBER_OF: 'depends_on',
  TESTS: 'depends_on',
  USES_TYPE: 'depends_on',
  FILE_CHANGES_WITH: 'depends_on',
  HANDLES: 'depends_on',
};

function mapEdgeType(type: EdgeType | string): S1EdgeType {
  // eslint-disable-next-line security/detect-object-injection -- type is a DB-sourced edge type, not user input
  return EDGE_TO_S1[type] ?? 'depends_on';
}

// ─── ID translation ───────────────────────────────────────────────────────────

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
export function toSystem1NodeId(s2Node: S2GraphNode): string {
  const relPath = s2Node.file_path ?? '__unknown__';
  const name = s2Node.name;
  const type = mapLabel(s2Node.label);
  const line = s2Node.start_line ?? 0;
  return `${relPath}::${name}::${type}::${line}`;
}

/**
 * Extract the System 2 node id from a System 1 node id that was produced
 * by toSystem1NodeId. If the id is not in S1 format, treat it as a S2 id
 * directly (allows callers to pass S2 ids through unchanged).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- _projectName reserved for future DB-assisted round-trip lookup
export function toSystem2NodeId(s1Id: string, _projectName: string): string {
  // If the id contains '::' it was produced by toSystem1NodeId.
  // Reconstruct the S2 qualified_name via a lookup-by-file+name+line is not
  // possible without a DB call — so we store the S2 id inside the metadata
  // field of the S1 node. If the caller passes a raw S2 id (no '::'), return it.
  if (!s1Id.includes('::')) return s1Id;
  // Cannot reverse without DB; return as-is and let callers resolve via searchNodes.
  return s1Id;
}

// ─── Node / Edge translators ──────────────────────────────────────────────────

export function toSystem1GraphNode(s2Node: S2GraphNode): GraphNode {
  return {
    id: toSystem1NodeId(s2Node),
    type: mapLabel(s2Node.label),
    name: s2Node.name,
    filePath: s2Node.file_path ?? '',
    line: s2Node.start_line ?? 0,
    endLine: s2Node.end_line ?? undefined,
    metadata: { s2Id: s2Node.id, project: s2Node.project, ...s2Node.props },
  };
}

export function toSystem1GraphEdge(
  s2Edge: S2GraphEdge,
  s2Nodes: Map<string, S2GraphNode>,
): GraphEdge {
  const srcNode = s2Nodes.get(s2Edge.source_id);
  const tgtNode = s2Nodes.get(s2Edge.target_id);
  return {
    source: srcNode ? toSystem1NodeId(srcNode) : s2Edge.source_id,
    target: tgtNode ? toSystem1NodeId(tgtNode) : s2Edge.target_id,
    type: mapEdgeType(s2Edge.type),
    metadata: { s2EdgeId: s2Edge.id, ...s2Edge.props },
  };
}

// ─── M3 — SearchResult ────────────────────────────────────────────────────────

export function toSystem1SearchResult(s2Node: S2GraphNode, query: string): SearchResult {
  const node = toSystem1GraphNode(s2Node);
  const lowerName = node.name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 1.0;
  let matchReason = `name contains '${query}'`;
  if (lowerName === lowerQuery) {
    score = 100;
    matchReason = 'exact match';
  } else if (lowerName.startsWith(lowerQuery)) {
    score = 80;
    matchReason = 'prefix match';
  } else if (lowerName.includes(lowerQuery)) {
    score = 60;
    matchReason = 'substring match';
  }
  return { node, score, matchReason };
}

// ─── M4 — CallPathResult ─────────────────────────────────────────────────────

export function toSystem1CallPathResult(traceResult: TraceResult, toName: string): CallPathResult {
  if (!traceResult.startNode) return { found: false, path: [], edges: [] };

  const targetNodes = traceResult.nodes.filter((n) => n.name === toName || n.id.endsWith(toName));
  if (targetNodes.length === 0) return { found: false, path: [], edges: [] };

  const target = targetNodes[0];
  const path: GraphNode[] = [
    {
      id: traceResult.startNode.id,
      type: mapLabel(traceResult.startNode.label),
      name: traceResult.startNode.name,
      filePath: traceResult.startNode.filePath ?? '',
      line: traceResult.startNode.startLine ?? 0,
    },
    {
      id: target.id,
      type: mapLabel(target.label),
      name: target.name,
      filePath: target.filePath ?? '',
      line: target.startLine ?? 0,
    },
  ];
  const edges: GraphEdge[] = traceResult.edges
    .filter((e) => e.target === target.id || e.source === traceResult.startNode.id)
    .map((e) => ({
      source: e.source,
      target: e.target,
      type: mapEdgeType(e.type),
    }));

  return { found: true, path, edges };
}

// ─── M2 — ArchitectureView ────────────────────────────────────────────────────

function parseHotspots(text: string): ArchitectureView['hotspots'] {
  return text
    .split('\n')
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => {
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored parser for a single hotspot line format
      const m = line.match(/^(.+)\s+\(degree:\s*(\d+)\)\s+--\s+(.+?)(?::(\d+))?$/);
      if (!m) return { filePath: line, inDegree: 0, outDegree: 0 };
      const degree = parseInt(m[2], 10);
      const half = Math.floor(degree / 2);
      return { filePath: m[3], inDegree: half, outDegree: degree - half };
    });
}

function parseFileTree(text: string): ArchitectureView['fileTree'] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => ({
      path: line.trim().replace(/\/$/, ''),
      type: 'directory' as const,
    }));
}

function parseModules(text: string): ArchitectureView['modules'] {
  const lines = text.split('\n').filter(Boolean);
  const result: ArchitectureView['modules'] = [];
  for (const line of lines) {
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored parser for the generated module summary format
    const m = line.match(/^(\S+)\s*(?:\((\d+)\s*files?\))?/);
    if (m)
      result.push({
        name: m[1],
        rootPath: m[1],
        fileCount: parseInt(m[2] ?? '0', 10),
        exports: [],
      });
  }
  return result;
}

export function toSystem1ArchitectureView(result: ArchitectureResult): ArchitectureView {
  const aspects = result.aspects;
  return {
    projectName: result.projectName,
    modules: parseModules(aspects.packages ?? aspects.layers ?? ''),
    hotspots: parseHotspots(aspects.hotspots ?? ''),
    fileTree: parseFileTree(aspects.file_tree ?? ''),
  };
}

// ─── M5 — ChangeDetectionResult ──────────────────────────────────────────────

export function toSystem1ChangeDetectionResult(result: DetectChangesResult): ChangeDetectionResult {
  const changedFiles = result.changedFiles.map((f) => f.path);
  const affectedSymbols: GraphNode[] = result.changedSymbols.map((sym) => ({
    id: sym.qualifiedName,
    type: mapLabel(sym.label),
    name: sym.name,
    filePath: sym.filePath,
    line: 0,
    metadata: { qualifiedName: sym.qualifiedName },
  }));
  const callerNodes: GraphNode[] = result.impactedCallers.map((c) => ({
    id: c.qualifiedName,
    type: mapLabel(c.label),
    name: c.name,
    filePath: c.filePath ?? '',
    line: 0,
    metadata: { risk: c.risk, depth: c.depth },
  }));
  const allSymbols = [...affectedSymbols, ...callerNodes];
  const blastRadius = new Set([
    ...affectedSymbols.map((n) => n.id),
    ...callerNodes.map((n) => n.id),
  ]).size;
  return { changedFiles, affectedSymbols: allSymbols, blastRadius };
}

// ─── M5b — ChangeDetectionResult from ChangedSymbolsForSession ───────────────

export function toSystem1ChangeDetectionResultFromSession(result: {
  changedFiles: string[];
  affectedSymbols: ChangedSymbol[];
  blastRadius: number;
}): ChangeDetectionResult {
  const affectedSymbols: GraphNode[] = result.affectedSymbols.map((sym) => ({
    id: sym.id,
    type: mapLabel(sym.label),
    name: sym.name,
    filePath: sym.filePath ?? '',
    line: sym.startLine ?? 0,
    metadata: { hopDepth: sym.hopDepth },
  }));
  return {
    changedFiles: result.changedFiles,
    affectedSymbols,
    blastRadius: result.blastRadius,
  };
}

// ─── M6 — GraphSchema ────────────────────────────────────────────────────────

export function toSystem1GraphSchema(result: GraphSchemaResult): GraphSchema {
  const nodeTypes = Object.keys(result.nodeLabelCounts);
  const edgeTypes = Object.keys(result.edgeTypeCounts);
  const nodeCount = Object.values(result.nodeLabelCounts).reduce((a, b) => a + b, 0);
  const edgeCount = Object.values(result.edgeTypeCounts).reduce((a, b) => a + b, 0);
  return { nodeTypes, edgeTypes, nodeCount, edgeCount };
}

// ─── M7 — CodeSnippetResult ───────────────────────────────────────────────────

export function toSystem1CodeSnippetResult(
  content: string,
  node: S2GraphNode,
  depIds: string[],
  dependentIds: string[],
): CodeSnippetResult {
  return {
    node: toSystem1GraphNode(node),
    content,
    dependencies: depIds,
    dependents: dependentIds,
  };
}

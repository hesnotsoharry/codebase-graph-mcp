/**
 * queryEngineSupport.ts — Helper functions extracted from queryEngine.ts
 * to keep the main file under the max-lines / max-lines-per-function limits.
 */

import fs from 'fs';
import path from 'path';

import { gitExec } from './gitExec';
import type { GraphDatabase } from './graphDatabase';
import type { EdgeType, GraphNode } from './graphDatabaseTypes';
import type {
  ChangedFileInfo,
  ChangedSymbol,
  CodeSearchOptions,
  CodeSearchResult,
  DetectChangesOptions,
  ImpactedCaller,
  RiskLevel,
  TraceEdge,
  TraceNode,
  TraceResult,
} from './queryEngineTypes';

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_BFS_NODES = 200;
export const MAX_DEPTH = 5;
export const CALL_EDGE_TYPES: EdgeType[] = ['CALLS', 'HTTP_CALLS', 'ASYNC_CALLS'];
export const SYMBOL_LABELS = ['Function', 'Method', 'Class', 'Interface', 'Type', 'Enum'] as const;

// ─── Trace edge helpers ───────────────────────────────────────────────────────

export function collectTraceEdges(pathNodes: string[], traceEdges: TraceEdge[]): void {
  for (let i = 0; i < pathNodes.length - 1; i++) {
    // eslint-disable-next-line security/detect-object-injection -- i is a bounded loop index over a trusted array
    traceEdges.push({ source: pathNodes[i], target: pathNodes[i + 1], type: 'CALLS' });
  }
}

// ─── Risk classification ──────────────────────────────────────────────────────

export function classifyRisk(db: GraphDatabase, node: GraphNode, depth: number): RiskLevel {
  const props = node.props as Record<string, unknown>;

  if (props.is_entry_point && depth <= 1) return 'CRITICAL';

  const inboundDegree =
    db.getNodeDegree(node.id, 'CALLS', 'in') + db.getNodeDegree(node.id, 'ASYNC_CALLS', 'in');

  if (inboundDegree > 10) return 'CRITICAL';
  if (inboundDegree > 5 || depth <= 1) return 'HIGH';
  if (inboundDegree > 2 || depth <= 2) return 'MEDIUM';
  return 'LOW';
}

// ─── Signature extraction ─────────────────────────────────────────────────────

export function getNodeSignature(node: GraphNode): string | null {
  const props = node.props as Record<string, unknown>;
  return (props.signature as string) ?? null;
}

// ─── traceCallPath helpers ────────────────────────────────────────────────────

export function deduplicateTraceResult(result: TraceResult): TraceResult {
  const seenNodes = new Set<string>();
  const uniqueNodes = result.nodes.filter((n) => {
    if (seenNodes.has(n.id)) return false;
    seenNodes.add(n.id);
    return true;
  });

  const seenEdges = new Set<string>();
  const uniqueEdges = result.edges.filter((e) => {
    const key = `${e.source}|${e.target}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });

  return { ...result, nodes: uniqueNodes, edges: uniqueEdges, totalNodes: uniqueNodes.length };
}

export function buildImpactSummary(riskCounts: Record<RiskLevel, number>): string {
  return `Impact: ${riskCounts.CRITICAL} critical, ${riskCounts.HIGH} high, ${riskCounts.MEDIUM} medium, ${riskCounts.LOW} low`;
}

// ─── detectChanges helpers ────────────────────────────────────────────────────

export function buildChangedSymbols(
  db: GraphDatabase,
  projectName: string,
  changedFiles: ChangedFileInfo[],
): ChangedSymbol[] {
  const changedSymbols: ChangedSymbol[] = [];
  for (const file of changedFiles) {
    if (file.status === 'deleted') continue;

    const fileNodes = db.getNodesByFile(projectName, file.path);
    for (const node of fileNodes) {
      if ((SYMBOL_LABELS as readonly string[]).includes(node.label)) {
        changedSymbols.push({
          name: node.name,
          label: node.label,
          filePath: file.path,
          qualifiedName: node.id,
        });
      }
    }
  }
  return changedSymbols;
}

interface ImpactedCallersOptions {
  db: GraphDatabase;
  changedSymbols: ChangedSymbol[];
  clampedDepth: number;
  classifyFn: (node: GraphNode, depth: number) => RiskLevel;
  minConfidence?: number;
}

export function buildImpactedCallers({
  db,
  changedSymbols,
  clampedDepth,
  classifyFn,
  minConfidence,
}: ImpactedCallersOptions): ImpactedCaller[] {
  const impactedCallers: ImpactedCaller[] = [];
  const seen = new Set<string>();
  const changedIds = new Set(changedSymbols.map((s) => s.qualifiedName));

  for (const symbol of changedSymbols) {
    const bfsResults = db.bfsTraversal({
      startNodeId: symbol.qualifiedName,
      edgeTypes: CALL_EDGE_TYPES,
      direction: 'inbound',
      maxDepth: clampedDepth,
      maxNodes: 100,
      minConfidence,
    });

    for (const result of bfsResults) {
      if (seen.has(result.id)) continue;
      seen.add(result.id);
      if (changedIds.has(result.id)) continue;

      const node = db.getNode(result.id);
      if (!node) continue;

      impactedCallers.push({
        name: node.name,
        label: node.label,
        filePath: node.file_path,
        qualifiedName: node.id,
        depth: result.depth,
        risk: classifyFn(node, result.depth),
      });
    }
  }
  return impactedCallers;
}

// ─── getGitChangedFiles ────────────────────────────────────────────────────────

function buildGitDiffArgs(options: DetectChangesOptions): string[] {
  switch (options.scope) {
    case 'unstaged':
      return ['diff', '--name-status'];
    case 'staged':
      return ['diff', '--cached', '--name-status'];
    case 'all':
      return ['diff', 'HEAD', '--name-status'];
    case 'branch': {
      const base = options.baseBranch ?? 'main';
      return ['diff', `${base}...HEAD`, '--name-status'];
    }
  }
}

function parseFileStatus(statusChar: string): ChangedFileInfo['status'] {
  switch (statusChar) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'modified';
  }
}

export async function getGitChangedFiles(
  options: DetectChangesOptions,
  projectRoot: string,
): Promise<ChangedFileInfo[]> {
  const args = buildGitDiffArgs(options);
  try {
    const { stdout } = await gitExec(args, { cwd: projectRoot, maxBuffer: 5 * 1024 * 1024 });
    const output = stdout.trim();
    if (!output) return [];
    return output.split('\n').map((line) => {
      const [status, ...pathParts] = line.split('\t');
      const filePath = pathParts.join('\t');
      return { path: filePath, status: parseFileStatus(status.charAt(0)) };
    });
  } catch {
    return [];
  }
}

// ─── searchCode helpers ────────────────────────────────────────────────────────

function buildSearchRegex(options: CodeSearchOptions): RegExp | null {
  try {
    const flags = options.caseSensitive ? 'g' : 'gi';
    if (options.regex) {
      // eslint-disable-next-line security/detect-non-literal-regexp -- pattern is intentionally user-supplied regex; caller validates via try/catch
      return new RegExp(options.pattern, flags);
    }
    const escaped = options.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // eslint-disable-next-line security/detect-non-literal-regexp -- pattern is escaped literal string, not a raw user regex
    return new RegExp(escaped, flags);
  } catch {
    return null;
  }
}

function buildFileFilter(filePattern: string | undefined): RegExp | null {
  if (!filePattern) return null;
  try {
    // Two-pass: first protect ** before replacing *, then restore
    const globToRegex = filePattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '<<DS>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<DS>>/g, '.*')
      .replace(/\?/g, '.');
    // eslint-disable-next-line security/detect-non-literal-regexp -- pattern built from glob escaping, not user regex
    return new RegExp(globToRegex);
  } catch {
    return null;
  }
}

interface FileSearchContext {
  filePath: string;
  absolutePath: string;
  regex: RegExp;
  results: CodeSearchResult[];
  offset: number;
  maxResults: number;
}

function searchFileContent(ctx: FileSearchContext, total: number): number {
  let content: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from trusted graph node
    content = fs.readFileSync(ctx.absolutePath, 'utf-8');
  } catch {
    return total;
  }

  let runningTotal = total;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    ctx.regex.lastIndex = 0;
    // eslint-disable-next-line security/detect-object-injection -- i is a bounded loop index
    const match = ctx.regex.exec(lines[i]);
    if (match) {
      runningTotal++;
      if (runningTotal > ctx.offset && ctx.results.length < ctx.maxResults) {
        ctx.results.push({
          filePath: ctx.filePath,
          lineNumber: i + 1,
          // eslint-disable-next-line security/detect-object-injection -- i is a bounded loop index
          lineContent: lines[i].slice(0, 200),
          matchStart: match.index,
          matchEnd: match.index + match[0].length,
        });
      }
    }
  }
  return runningTotal;
}

export function searchCodeFiles(
  db: GraphDatabase,
  projectName: string,
  projectRoot: string,
  options: CodeSearchOptions,
): { results: CodeSearchResult[]; total: number; hasMore: boolean } {
  const maxResults = options.maxResults ?? 100;
  const offset = options.offset ?? 0;

  const regex = buildSearchRegex(options);
  if (!regex) return { results: [], total: 0, hasMore: false };

  const fileFilter = buildFileFilter(options.filePattern);
  if (options.filePattern && !fileFilter) return { results: [], total: 0, hasMore: false };

  const files = db.getNodesByLabel(projectName, 'File');
  const results: CodeSearchResult[] = [];
  let total = 0;

  for (const file of files) {
    const filePath = (file.props as Record<string, unknown>).path as string;
    if (!filePath) continue;
    if (fileFilter && !fileFilter.test(filePath)) continue;

    const absolutePath = path.resolve(projectRoot, filePath);
    total = searchFileContent(
      { filePath, absolutePath, regex, results, offset, maxResults },
      total,
    );
  }

  return { results, total, hasMore: total > offset + maxResults };
}

// ─── computeLayers helpers ────────────────────────────────────────────────────

const LAYER_KEYWORDS: Array<[string, string[]]> = [
  ['Presentation', ['component', 'view', 'page', 'renderer', 'ui', 'frontend']],
  ['API/Routes', ['route', 'api', 'controller', 'handler', 'endpoint']],
  ['Business Logic', ['service', 'usecase', 'domain', 'logic', 'core']],
  ['Data Access', ['model', 'repo', 'database', 'store', 'db', 'data']],
  ['Configuration', ['config', 'setting', 'env']],
  ['Infrastructure', ['infra', 'deploy', 'docker', 'ci', 'scripts']],
];

function classifyFolderPath(p: string): string | null {
  for (const [layer, keywords] of LAYER_KEYWORDS) {
    if (keywords.some((kw) => p.includes(kw))) return layer;
  }
  return null;
}

export function buildRiskSummaryFromNodes(nodes: TraceNode[]): string {
  const riskCounts: Record<RiskLevel, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const n of nodes) {
    if (n.risk) riskCounts[n.risk]++;
  }
  return buildImpactSummary(riskCounts);
}

export function buildLayerMap(db: GraphDatabase, projectName: string): Record<string, string[]> {
  const folders = db.getNodesByLabel(projectName, 'Folder');
  const layerMap = new Map<string, string[]>([
    ['Presentation', []],
    ['API/Routes', []],
    ['Business Logic', []],
    ['Data Access', []],
    ['Configuration', []],
    ['Infrastructure', []],
  ]);

  for (const folder of folders) {
    const p = (((folder.props as Record<string, unknown>).path as string) ?? '').toLowerCase();
    const layer = classifyFolderPath(p);
    if (layer) layerMap.get(layer)?.push(folder.name);
  }

  return Object.fromEntries(layerMap);
}

/**
 * graphControllerCompatQueries.ts — Query method implementations for the
 * GraphControllerCompat shim. Each function delegates to System 2 and
 * returns a System 1–shaped result via adapters.
 *
 * Kept in a separate file so graphControllerCompat.ts stays under 300 lines.
 */

import fs from 'fs/promises';
import path from 'path';

import { consoleErrorLogger as log } from './loggerInterface';
import type { CypherEngine } from './cypherEngine';
import {
  toSystem1ArchitectureView,
  toSystem1CallPathResult,
  toSystem1ChangeDetectionResult,
  toSystem1ChangeDetectionResultFromSession,
  toSystem1CodeSnippetResult,
  toSystem1GraphNode,
  toSystem1GraphSchema,
  toSystem1SearchResult,
} from './graphControllerCompatAdapters';
import type { GraphDatabase } from './graphDatabase';
import type {
  CallPathResult,
  ChangeDetectionResult,
  CodeSnippetResult,
  GraphSchema,
  SearchResult,
} from './graphTypes';
import type { ArchitectureView } from './graphTypes';
import type { QueryEngine } from './queryEngine';

// ─── M3 — searchGraph ────────────────────────────────────────────────────────

export function compatSearchGraph(
  db: GraphDatabase,
  projectName: string,
  query: string,
  limit = 20,
): SearchResult[] {
  const result = db.searchNodes({
    project: projectName,
    namePattern: query,
    limit: limit * 2, // over-fetch to allow sorting
  });
  return result.nodes
    .map((node) => toSystem1SearchResult(node, query))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─── queryGraph ───────────────────────────────────────────────────────────────

export function compatQueryGraph(
  cypherEngine: CypherEngine,
  query: string,
): Array<Record<string, unknown>> {
  try {
    const result = cypherEngine.execute(query);
    return result.rows;
  } catch (err) {
    log.warn('[compat] queryGraph error:', err);
    return [];
  }
}

// ─── M4 — traceCallPath ──────────────────────────────────────────────────────

export function compatTraceCallPath(
  queryEngine: QueryEngine,
  fromName: string,
  toName: string,
  maxDepth = 5,
): CallPathResult {
  const clampedDepth = Math.min(Math.max(maxDepth, 1), 5);
  const traceResult = queryEngine.traceCallPath({
    functionName: fromName,
    direction: 'both',
    depth: clampedDepth,
    riskLabels: false,
  });
  return toSystem1CallPathResult(traceResult, toName);
}

// ─── M2 — getArchitecture ────────────────────────────────────────────────────

export function compatGetArchitecture(
  queryEngine: QueryEngine,
  aspects?: string[],
): ArchitectureView {
  const s2Aspects = aspects?.length
    ? (aspects as Parameters<typeof queryEngine.getArchitecture>[0])
    : ['all' as const];
  const result = queryEngine.getArchitecture(s2Aspects);
  return toSystem1ArchitectureView(result);
}

// ─── M7 — getCodeSnippet ─────────────────────────────────────────────────────

export async function compatGetCodeSnippet(
  db: GraphDatabase,
  queryEngine: QueryEngine,
  projectName: string,
  symbolId: string,
): Promise<CodeSnippetResult | null> {
  // symbolId may be a S1 id (path::name::type::line) or a S2 qualified_name
  const s2Node = db.getNode(symbolId) ?? findNodeByS1Id(db, projectName, symbolId);
  if (!s2Node) return null;

  const content = queryEngine.getCodeSnippet(s2Node.id) ?? '';

  const outEdges = db.getOutboundEdges(s2Node.id);
  const inEdges = db.getInboundEdges(s2Node.id);
  const depIds = outEdges.map((e) => e.target_id);
  const dependentIds = inEdges.map((e) => e.source_id);

  return toSystem1CodeSnippetResult(content, s2Node, depIds, dependentIds);
}

function findNodeByS1Id(
  db: GraphDatabase,
  projectName: string,
  s1Id: string,
): ReturnType<typeof db.getNode> {
  if (!s1Id.includes('::')) return null;
  const parts = s1Id.split('::');
  if (parts.length < 2) return null;
  const name = parts[1];
  const result = db.searchNodes({
    project: projectName,
    namePattern: name,
    caseSensitive: true,
    limit: 10,
  });
  return result.nodes.find((n) => n.name === name) ?? null;
}

// ─── M5 — detectChanges ──────────────────────────────────────────────────────

export async function compatDetectChanges(
  queryEngine: QueryEngine,
): Promise<ChangeDetectionResult> {
  try {
    const result = await queryEngine.detectChanges({ scope: 'all', depth: 3 });
    return toSystem1ChangeDetectionResult(result);
  } catch (err) {
    log.warn('[compat] detectChanges error:', err);
    return { changedFiles: [], affectedSymbols: [], blastRadius: 0 };
  }
}

// ─── detectChangesForSession ──────────────────────────────────────────────────

export function compatDetectChangesForSession(
  db: GraphDatabase,
  projectName: string,
  _sessionId: string,
  files: string[],
): ChangeDetectionResult {
  const result = db.detectChangesForSession(projectName, files);
  return toSystem1ChangeDetectionResultFromSession(result);
}

// ─── getGraphSchema ───────────────────────────────────────────────────────────

export function compatGetGraphSchema(queryEngine: QueryEngine): GraphSchema {
  return toSystem1GraphSchema(queryEngine.getGraphSchema());
}

// ─── searchCode (port from System 1 graphQuery.ts) ────────────────────────────

export interface CompatSearchCodeOptions {
  projectRoot: string;
  db: GraphDatabase;
  projectName: string;
  pattern: string;
  opts?: { fileGlob?: string; maxResults?: number };
}

export async function compatSearchCode({
  projectRoot,
  db,
  projectName,
  pattern,
  opts,
}: CompatSearchCodeOptions): Promise<Array<{ filePath: string; line: number; match: string }>> {
  const maxResults = opts?.maxResults ?? 100;
  const results: Array<{ filePath: string; line: number; match: string }> = [];

  let regex: RegExp;
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp -- pattern is user-provided search query
    regex = new RegExp(pattern, 'gi');
  } catch {
    return results;
  }

  const fileNodes = db.getNodesByLabel(projectName, 'File');
  const fileGlob = opts?.fileGlob;

  for (const fileNode of fileNodes) {
    if (results.length >= maxResults) break;
    const filePath = (fileNode.props as Record<string, unknown>).path as string;
    if (!filePath) continue;
    if (fileGlob && !matchGlob(filePath, fileGlob)) continue;
    await searchFileLines({ projectRoot, filePath, regex, maxResults, results });
  }

  return results;
}

function matchGlob(filePath: string, glob: string): boolean {
  const regexStr = glob
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp -- glob is from caller's file filter
    const fullRe = new RegExp(`^${regexStr}$`);
    // eslint-disable-next-line security/detect-non-literal-regexp -- glob is from caller's file filter
    const partialRe = new RegExp(regexStr);
    return fullRe.test(filePath) || partialRe.test(filePath);
  } catch {
    return false;
  }
}

interface SearchFileLinesOptions {
  projectRoot: string;
  filePath: string;
  regex: RegExp;
  maxResults: number;
  results: Array<{ filePath: string; line: number; match: string }>;
}

async function searchFileLines({
  projectRoot,
  filePath,
  regex,
  maxResults,
  results,
}: SearchFileLinesOptions): Promise<void> {
  const fullPath = path.join(projectRoot, filePath);
  let content: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from indexed project files
    content = await fs.readFile(fullPath, 'utf-8');
  } catch {
    return;
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && results.length < maxResults; i++) {
    regex.lastIndex = 0;
    // eslint-disable-next-line security/detect-object-injection -- i is a numeric loop index
    if (regex.test(lines[i])) {
      // eslint-disable-next-line security/detect-object-injection -- i is a numeric loop index
      results.push({ filePath, line: i + 1, match: lines[i].trim() });
    }
  }
}

// ─── IndexStatus helper ───────────────────────────────────────────────────────

export function compatGetIndexStatus(
  db: GraphDatabase,
  projectName: string,
  projectRoot: string,
  initialized: boolean,
): import('./graphTypes').IndexStatus {
  const project = db.getProject(projectName);
  // Read live counts — stored counts on the project row are only refreshed at the
  // end of finalizeIndex and can lag reality after incremental updates.
  const nodeCount = db.getNodeCount(projectName);
  const edgeCount = db.getEdgeCount(projectName);
  const fileNodes = db.getNodesByLabel(projectName, 'File');
  return {
    initialized,
    projectRoot,
    projectName,
    nodeCount,
    edgeCount,
    fileCount: fileNodes.length,
    lastIndexedAt: project?.indexed_at ?? 0,
    indexDurationMs: 0,
  };
}

// ─── toSystem1GraphNode re-export (convenience for compat class) ──────────────

export { toSystem1GraphNode };

/**
 * mcpToolHandlerDefs.ts — Tool handler implementations extracted from
 * mcpToolHandlers.ts to keep the factory function under the line limit.
 */

import { xxh3 } from '@node-rs/xxhash';
import fs from 'fs';
import path from 'path';

import type { EdgeType } from './graphDatabaseTypes';
import { truncate } from './mcpToolHandlerHelpers';
import type { GraphToolContext } from './mcpToolHandlers';

// Wave 70 Phase B1+B2 — `handleIndexStatus` and `handleGetArchitecture` were
// moved to `mcpToolHandlerStructured.ts` (envelope-returning handlers with
// `structuredContent`). Re-export them here for back-compat with existing
// imports from `mcpToolHandlerDefs`.
export { handleGetArchitecture, handleIndexStatus } from './mcpToolHandlerStructured';

// ─── index_repository handler ─────────────────────────────────────────────────

export async function handleIndexRepository(
  args: Record<string, unknown>,
  ctx: GraphToolContext,
): Promise<string> {
  try {
    const repoPath = (args.repo_path as string) ?? ctx.projectRoot;
    const result = await ctx.pipeline.index({
      projectRoot: repoPath,
      incremental: true,
      onProgress: () => {},
    });
    if (!result.success) return `Indexing failed: ${result.errors.join(', ')}`;
    return [
      `Indexed "${result.projectName}" successfully.`,
      `Files: ${result.filesIndexed} indexed, ${result.filesSkipped} skipped (unchanged)`,
      `Nodes: ${result.nodesCreated}`,
      `Edges: ${result.edgesCreated}`,
      `Duration: ${result.durationMs}ms`,
      result.incremental ? '(incremental reindex)' : '(full reindex)',
    ].join('\n');
  } catch (err) {
    return `Error indexing repository: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── list_projects handler ────────────────────────────────────────────────────

export async function handleListProjects(ctx: GraphToolContext): Promise<string> {
  try {
    const projects = ctx.db.listProjects();
    if (projects.length === 0) return 'No projects indexed yet.';
    return truncate(
      projects
        .map(
          (p) =>
            `${p.name}: ${p.node_count} nodes, ${p.edge_count} edges (indexed ${new Date(p.indexed_at).toISOString()})`,
        )
        .join('\n'),
    );
  } catch (err) {
    return `Error listing projects: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── delete_project handler ───────────────────────────────────────────────────

export async function handleDeleteProject(
  args: Record<string, unknown>,
  ctx: GraphToolContext,
): Promise<string> {
  try {
    const name = args.project_name as string;
    if (!ctx.db.getProject(name)) return `Project "${name}" not found.`;
    ctx.db.deleteProject(name);
    return `Deleted project "${name}" and all its graph data.`;
  } catch (err) {
    return `Error deleting project: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── get_graph_schema handler ─────────────────────────────────────────────────

const SUPPORTED_CYPHER_FEATURES = [
  'MATCH (n:Label) WHERE ... RETURN ...',
  'MATCH (a)-[:TYPE]->(b), (a)<-[:TYPE]-(b)',
  'MATCH (a)-[:TYPE*1..N]->(b)  — variable-length path',
  'MATCH (a)-[:X]->(b), (b)-[:Y]->(c)  — multi-pattern (comma-separated)',
  'OPTIONAL MATCH (a)-[:TYPE]->(b)  — LEFT JOIN; unmatched right side returns null',
  'UNWIND [v1, v2, ...] AS x  — literal list only; no pipeline UNWIND',
  'WHERE: =, <>, <, >, <=, >=, CONTAINS, STARTS WITH, ENDS WITH, IN, AND, OR',
  'RETURN n.prop, COUNT(*), COUNT(n), labels(n), DISTINCT',
  'ORDER BY n.prop [ASC|DESC], LIMIT N',
  'Node columns (direct): name, qualified_name, file_path, start_line, end_line, label, id, project',
  'Any other property name falls through to JSON_EXTRACT on the node props blob',
  'indexed_at comparisons: ISO date strings (e.g. "2026-01-01") are auto-coerced to epoch ms',
  'NOT supported: WITH (pipeline), parametric UNWIND, function calls (datetime(), length(), etc.)',
];

export async function handleGetGraphSchema(ctx: GraphToolContext): Promise<string> {
  try {
    const schema = ctx.queryEngine.getGraphSchema();
    const lines = [
      'Node labels:',
      ...Object.entries(schema.nodeLabelCounts).map(([l, c]) => `  ${l}: ${c}`),
      '',
      'Edge types:',
      ...Object.entries(schema.edgeTypeCounts).map(([t, c]) => `  ${t}: ${c}`),
      '',
      'Edge fields:',
      '  confidence: float 0.0–1.0. CALLS/ASYNC_CALLS edges only — set by call-resolution pass.',
      '    Import-resolved: ~0.95 | Same-file definition: ~0.85 | Name-unique: ~0.80 | New-expression class: ~0.65',
      '    All other edge types default to 1.0. Use min_confidence on trace_call_path / detect_changes to filter.',
      '',
      'Relationship patterns:',
      ...schema.relationshipPatterns.map((p) => `  ${p}`),
      '',
      'Sample function names:',
      ...schema.sampleNames.functions.map((n) => `  ${n}`),
      '',
      'Sample class names:',
      ...schema.sampleNames.classes.map((n) => `  ${n}`),
      '',
      'Sample qualified names:',
      ...schema.sampleNames.qualifiedNames.map((n) => `  ${n}`),
      '',
      'Supported Cypher features (query_graph):',
      ...SUPPORTED_CYPHER_FEATURES.map((f) => `  ${f}`),
    ];
    return truncate(lines.join('\n'));
  } catch (err) {
    return `Error getting graph schema: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// `handleGetArchitecture` moved to `mcpToolHandlerStructured.ts` — re-exported
// at the top of this file for back-compat.

// ─── search_code handler ──────────────────────────────────────────────────────

export async function handleSearchCode(
  args: Record<string, unknown>,
  ctx: GraphToolContext,
): Promise<string> {
  try {
    const result = ctx.queryEngine.searchCode({
      pattern: args.pattern as string,
      filePattern: args.file_pattern as string | undefined,
      regex: args.regex as boolean | undefined,
      caseSensitive: args.case_sensitive as boolean | undefined,
      maxResults: (args.max_results as number) ?? 100,
      offset: args.offset as number | undefined,
    });
    if (result.results.length === 0) return 'No matches found.';
    const lines = [
      `Found ${result.total} matches:`,
      ...result.results.map((r) => `${r.filePath}:${r.lineNumber}: ${r.lineContent}`),
    ];
    if (result.hasMore)
      lines.push(
        `... more results available. Use offset=${((args.offset as number) ?? 0) + result.results.length}`,
      );
    return truncate(lines.join('\n'));
  } catch (err) {
    return `Error searching code: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── get_code_snippet handler ─────────────────────────────────────────────────

function resolveQualifiedName(
  value: string,
  ctx: GraphToolContext,
): { qn: string | null; error?: string } {
  if (ctx.db.getNode(value)) return { qn: value };
  const matches = ctx.db.searchNodes({
    project: ctx.projectName,
    namePattern: value,
    caseSensitive: true,
    limit: 5,
  });
  const exact = matches.nodes.filter((n) => n.name === value);
  if (exact.length === 1) return { qn: exact[0].qualified_name };
  if (exact.length > 1) {
    const names = exact.map((n) => n.qualified_name).join(', ');
    return { qn: null, error: `Error: ambiguous symbol '${value}'; matched ${exact.length} qualified names: ${names}` };
  }
  return { qn: null };
}

function isFileStale(filePath: string, ctx: GraphToolContext): boolean {
  const indexed = ctx.db.getFileHash(ctx.projectName, filePath);
  if (!indexed) return false;
  const absolutePath = path.resolve(ctx.projectRoot, filePath);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from trusted graph node
    const content = fs.readFileSync(absolutePath);
    const currentHash = xxh3.xxh128(content).toString(16).padStart(32, '0');
    return currentHash !== indexed.content_hash;
  } catch {
    return false;
  }
}

function formatSnippet(qn: string, ctx: GraphToolContext): string {
  const node = ctx.db.getNode(qn);
  if (!node) return `Symbol not found: ${qn}`;
  const snippet = ctx.queryEngine.getCodeSnippet(qn);
  if (!snippet) return `Could not read source for: ${qn}`;
  const props = node.props as Record<string, unknown>;
  const stale = node.file_path ? isFileStale(node.file_path, ctx) : false;
  const headerLines = [
    stale
      ? '⚠ Note: file changed since indexing — line offsets may be stale. Re-index for fresh source.'
      : null,
    `${node.label} ${node.name}`,
    props.signature ? `Signature: ${props.signature}` : null,
    `File: ${node.file_path}:${node.start_line}-${node.end_line}`,
    `Module: ${node.qualified_name.split('.').slice(0, -1).join('.')}`,
    '',
  ];
  const header = headerLines.filter(Boolean).join('\n');
  return truncate(header + snippet);
}

export async function handleGetCodeSnippet(
  args: Record<string, unknown>,
  ctx: GraphToolContext,
): Promise<string> {
  try {
    const raw = args.symbol as string | undefined;
    if (!raw) return "Error: missing required parameter 'symbol'";
    const resolved = resolveQualifiedName(raw, ctx);
    if (resolved.error) return resolved.error;
    if (!resolved.qn) return `Symbol not found: ${raw}`;
    return formatSnippet(resolved.qn, ctx);
  } catch (err) {
    return `Error getting code snippet: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── ingest_traces handler ────────────────────────────────────────────────────

interface TraceEdgeInput {
  fromId: string;
  toId: string;
  type: string;
  weight?: number;
}

function parseTraces(raw: unknown): TraceEdgeInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t): t is TraceEdgeInput =>
      typeof t === 'object' &&
      t !== null &&
      typeof (t as TraceEdgeInput).fromId === 'string' &&
      typeof (t as TraceEdgeInput).toId === 'string' &&
      typeof (t as TraceEdgeInput).type === 'string',
  );
}

export async function handleIngestTraces(
  args: Record<string, unknown>,
  ctx: GraphToolContext,
): Promise<string> {
  try {
    const rawTraces = args.traces;
    if (!rawTraces) return "Error: missing required parameter 'traces'";
    if (typeof rawTraces !== 'string') return "Error: parameter 'traces' must be a JSON string";
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawTraces);
    } catch {
      return "Error: parameter 'traces' is not valid JSON";
    }
    const traces = parseTraces(parsed);
    if (traces.length === 0) return 'No valid trace edges in payload.';
    const edges = traces.map((t) => ({
      project: ctx.projectName,
      source_id: t.fromId,
      target_id: t.toId,
      type: t.type as EdgeType,
      props: t.weight !== undefined ? { weight: t.weight } : {},
    }));
    ctx.db.insertEdges(edges);
    return `Ingested ${edges.length} trace edge(s) into project "${ctx.projectName}".`;
  } catch (err) {
    return `Error ingesting traces: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * mcpToolHandlerHelpers.ts — Handler implementations extracted from mcpToolHandlers.ts
 * to keep the factory function and each handler under the max-lines-per-function limit.
 */

import type { McpToolResult } from './types';
import { textResult } from './types';
import type { CypherEngine } from './cypherEngine';
import type { GraphToolContext } from './graphTypes';
import { hasOnlyQuery, runFilteredSearch, runRankedSearch } from './mcpToolHandlerSearch';
import { assertString } from './mcpToolHandlerValidation';
import type { QueryEngine } from './queryEngine';

// ─── Shared output helper ─────────────────────────────────────────────────────

const MAX_OUTPUT_CHARS = 8000;

export function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + '\n... (output truncated at 8000 chars)';
}

// ─── Tool 5: search_graph handler ────────────────────────────────────────────

export async function handleSearchGraph(
  args: Record<string, unknown>,
  ctx: GraphToolContext,
): Promise<string> {
  // Wave 70 Phase B3: `name_pattern` deprecated alias dropped. `query` is the
  // only accepted parameter name.
  const namePattern = args.query as string | undefined;
  // 3-tier ranked path when caller passed just `query` (no filter args).
  if (namePattern && hasOnlyQuery(args)) {
    return runRankedSearch(ctx, namePattern, (args.limit as number) ?? 100);
  }
  return runFilteredSearch(args, ctx, namePattern);
}

// ─── Tool 10: trace_call_path handler ────────────────────────────────────────

type TraceNode = {
  depth: number;
  label: string;
  name: string;
  signature?: string | null;
  risk?: string;
  filePath?: string | null;
  startLine?: number | null;
};

function formatTraceDepthGroup(depth: number, nodes: TraceNode[]): string[] {
  const lines = [`Depth ${depth}:`];
  for (const node of nodes) {
    const risk = node.risk ? ` [${node.risk}]` : '';
    const sig = node.signature ? ` ${node.signature}` : '';
    lines.push(`  ${node.label} ${node.name}${sig}${risk}`);
    if (node.filePath) lines.push(`    ${node.filePath}:${node.startLine}`);
  }
  lines.push('');
  return lines;
}

function groupNodesByDepth(nodes: TraceNode[]): Map<number, TraceNode[]> {
  const byDepth = new Map<number, TraceNode[]>();
  for (const node of nodes) {
    const group = byDepth.get(node.depth) ?? [];
    group.push(node);
    byDepth.set(node.depth, group);
  }
  return byDepth;
}

function resolveDirection(raw: unknown): 'inbound' | 'outbound' | 'both' {
  if (raw === 'callers') return 'inbound';
  if (raw === 'callees') return 'outbound';
  if (raw === 'inbound' || raw === 'outbound' || raw === 'both') return raw;
  return 'both';
}

type TraceResult = {
  startNode: TraceNode | null;
  nodes: TraceNode[];
  totalNodes: number;
  truncated: boolean;
  impactSummary?: string;
};

function formatTraceResult(result: TraceResult, functionName: string): string {
  if (!result.startNode) return `Function "${functionName}" not found in the graph.`;
  const lines: string[] = [`Trace from: ${result.startNode.label} ${result.startNode.name}`];
  if (result.startNode.signature) lines.push(`  Signature: ${result.startNode.signature}`);
  if (result.startNode.filePath)
    lines.push(`  File: ${result.startNode.filePath}:${result.startNode.startLine}`);
  lines.push(
    '',
    `${result.totalNodes} connected nodes found${result.truncated ? ' (truncated at 200)' : ''}:`,
    '',
  );
  const byDepth = groupNodesByDepth(result.nodes);
  for (const [depth, nodes] of Array.from(byDepth.entries()).sort((a, b) => a[0] - b[0])) {
    lines.push(...formatTraceDepthGroup(depth, nodes));
  }
  if (result.impactSummary) lines.push(result.impactSummary);
  return truncate(lines.join('\n'));
}

export async function handleTraceCallPath(
  args: Record<string, unknown>,
  queryEngine: QueryEngine,
): Promise<string> {
  // Wave 70 Phase B3: `function_name` deprecated alias dropped. `symbol` only.
  const functionName = args.symbol as string | undefined;
  if (!functionName) {
    return "Error: missing required parameter 'symbol'";
  }
  const minConfidence = (args.min_confidence as number) ?? 0;
  const result = queryEngine.traceCallPath({
    functionName,
    direction: resolveDirection(args.direction),
    depth: Math.min(Math.max((args.depth as number) ?? 3, 1), 5),
    riskLabels: (args.risk_labels as boolean) ?? false,
    minConfidence: minConfidence > 0 ? minConfidence : undefined,
  });
  return formatTraceResult(result, functionName);
}

// ─── Tool 11: detect_changes handler ─────────────────────────────────────────
//
// Wave 70 Phase B1+B2: returns CallToolResult envelope with structuredContent.
// The text format mirrors the pre-Wave-70 string output for human readers.

function buildDetectChangesLines(result: {
  changedFiles: Array<{ status: string; path: string }>;
  changedSymbols: Array<{ label: string; name: string; filePath: string | null }>;
  impactedCallers: Array<{
    risk: string;
    label: string;
    name: string;
    depth: number;
    filePath: string | null;
  }>;
  riskSummary: Record<string, number>;
}): string[] {
  const lines: string[] = [
    `Changed files (${result.changedFiles.length}):`,
    ...result.changedFiles.map((f) => `  [${f.status}] ${f.path}`),
    '',
  ];
  if (result.changedSymbols.length > 0) {
    lines.push(`Changed symbols (${result.changedSymbols.length}):`);
    for (const sym of result.changedSymbols) {
      lines.push(`  ${sym.label} ${sym.name} (${sym.filePath})`);
    }
    lines.push('');
  }
  if (result.impactedCallers.length > 0) {
    lines.push(`Impacted callers (${result.impactedCallers.length}):`);
    for (const caller of result.impactedCallers) {
      lines.push(
        `  [${caller.risk}] ${caller.label} ${caller.name} (depth ${caller.depth}) -- ${caller.filePath}`,
      );
    }
    lines.push('');
  }
  lines.push('Risk summary:');
  for (const [level, count] of Object.entries(result.riskSummary)) {
    if (count > 0) lines.push(`  ${level}: ${count}`);
  }
  return lines;
}

export async function handleDetectChanges(
  args: Record<string, unknown>,
  queryEngine: QueryEngine,
): Promise<McpToolResult> {
  const rawMinConf = (args.min_confidence as number) ?? 0;
  const result = await queryEngine.detectChanges({
    scope: (args.scope as 'unstaged' | 'staged' | 'all' | 'branch') ?? 'all',
    baseBranch: args.base_branch as string | undefined,
    depth: Math.min(Math.max((args.depth as number) ?? 3, 1), 5),
    minConfidence: rawMinConf > 0 ? rawMinConf : undefined,
  });

  if (result.changedFiles.length === 0) {
    return textResult('No changes detected.', {
      structuredContent: {
        changedFiles: [],
        changedSymbols: [],
        impactedCallers: [],
        riskSummary: result.riskSummary,
      },
    });
  }

  const lines = buildDetectChangesLines(result);
  return textResult(truncate(lines.join('\n')), {
    structuredContent: {
      changedFiles: result.changedFiles,
      changedSymbols: result.changedSymbols,
      impactedCallers: result.impactedCallers,
      riskSummary: result.riskSummary,
    },
  });
}

// ─── Tool 13: manage_adr handler ─────────────────────────────────────────────

async function handleAdrGet(proj: string, ctx: GraphToolContext): Promise<string> {
  const adr = ctx.db.getAdr(proj);
  if (!adr) return `No ADR found for project "${proj}".`;
  return truncate(adr.summary);
}

async function handleAdrStore(
  proj: string,
  args: Record<string, unknown>,
  ctx: GraphToolContext,
): Promise<string> {
  const content = args.content as string;
  if (!content) return 'Error: content is required for store mode.';
  if (content.length > 8000) return 'Error: ADR content exceeds 8000 character limit.';

  ctx.db.upsertAdr({
    project: proj,
    summary: content,
    source_hash: '',
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  return `ADR stored for project "${proj}".`;
}

async function handleAdrUpdate(
  proj: string,
  args: Record<string, unknown>,
  ctx: GraphToolContext,
): Promise<string> {
  const sections = args.sections as Record<string, string> | undefined;
  if (!sections) return 'Error: sections object is required for update mode.';

  const validSections = ['PURPOSE', 'STACK', 'ARCHITECTURE', 'PATTERNS', 'TRADEOFFS', 'PHILOSOPHY'];
  for (const key of Object.keys(sections)) {
    if (!validSections.includes(key)) {
      return `Error: invalid section "${key}". Valid: ${validSections.join(', ')}`;
    }
  }

  const existing = ctx.db.getAdr(proj);
  let currentSections: Record<string, string> = {};
  if (existing) {
    try {
      currentSections = JSON.parse(existing.summary);
    } catch {
      currentSections = {};
    }
  }

  Object.assign(currentSections, sections);
  const merged = JSON.stringify(currentSections, null, 2);
  if (merged.length > 8000) return 'Error: merged ADR exceeds 8000 character limit.';

  ctx.db.upsertAdr({
    project: proj,
    summary: merged,
    source_hash: '',
    created_at: existing?.created_at ?? Date.now(),
    updated_at: Date.now(),
  });
  return `ADR updated for project "${proj}". Sections updated: ${Object.keys(sections).join(', ')}`;
}

export async function handleManageAdr(
  args: Record<string, unknown>,
  ctx: GraphToolContext,
): Promise<string> {
  const proj = (args.project as string) ?? ctx.projectName;
  // ADR storage is project-level by design (see Wave 20 Decision 4). Per-ID
  // targeting is not supported and was never wired through. If a consumer
  // needs per-ID retrieval, file a focused follow-up with the use case.
  const mode = args.mode as string;
  if (!mode) {
    return "Error: missing required parameter 'mode'";
  }

  switch (mode) {
    case 'list': {
      const adrs = ctx.db.listAdrs();
      if (adrs.length === 0) return 'No ADRs stored.';
      return truncate(
        adrs.map((a) => `${a.project}: updated ${new Date(a.updated_at).toISOString()}`).join('\n'),
      );
    }
    case 'get':
      return handleAdrGet(proj, ctx);
    case 'store':
      return handleAdrStore(proj, args, ctx);
    case 'update':
      return handleAdrUpdate(proj, args, ctx);
    case 'delete': {
      ctx.db.deleteAdr(proj);
      return `ADR deleted for project "${proj}".`;
    }
    default:
      return `Unknown mode: ${mode}`;
  }
}

// ─── Tool 12: query_graph handler ────────────────────────────────────────────
//
// Wave 70 Phase B1+B2: returns CallToolResult envelope with structuredContent
// (columns + rows + total) so consumers can parse without regex.

function formatQueryResultText(result: {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  total: number;
  truncated: boolean;
}): string {
  if (result.rows.length === 0) return 'No results.';

  const lines = [`Columns: ${result.columns.join(', ')}`, `Results: ${result.total}`, ''];

  if (result.truncated) {
    lines.push('(truncated — more rows exist; use offset/limit to page)');
    lines.push('');
  }

  for (const row of result.rows) {
    const values = result.columns.map((col) => {
      // eslint-disable-next-line security/detect-object-injection -- col comes from result.columns
      const val = row[col];
      return typeof val === 'object' ? JSON.stringify(val) : String(val ?? 'null');
    });
    lines.push(values.join(' | '));
  }

  return truncate(lines.join('\n'));
}

export async function handleQueryGraph(
  args: Record<string, unknown>,
  cypherEngine: CypherEngine,
): Promise<McpToolResult> {
  const queryResult = assertString(args, 'query');
  if (!queryResult.ok) return textResult(queryResult.error, { isError: true });
  const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : undefined;
  const offset = typeof args.offset === 'number' && args.offset >= 0 ? args.offset : undefined;
  const result = cypherEngine.execute(queryResult.value, { limit, offset });
  return textResult(formatQueryResultText(result), {
    structuredContent: {
      columns: result.columns,
      rows: result.rows,
      total: result.total,
      truncated: result.truncated,
    },
  });
}

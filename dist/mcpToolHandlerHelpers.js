/**
 * mcpToolHandlerHelpers.ts — Handler implementations extracted from mcpToolHandlers.ts
 * to keep the factory function and each handler under the max-lines-per-function limit.
 */
import { textResult } from './types.js';
import { hasOnlyQuery, runFilteredSearch, runRankedSearch } from './mcpToolHandlerSearch.js';
import { assertString } from './mcpToolHandlerValidation.js';
// ─── Shared output helper ─────────────────────────────────────────────────────
const MAX_OUTPUT_CHARS = 8000;
export function truncate(text) {
    if (text.length <= MAX_OUTPUT_CHARS)
        return text;
    return text.slice(0, MAX_OUTPUT_CHARS) + '\n... (output truncated at 8000 chars)';
}
// ─── Tool 5: search_graph handler ────────────────────────────────────────────
export async function handleSearchGraph(args, ctx) {
    // Wave 70 Phase B3: `name_pattern` deprecated alias dropped. `query` is the
    // only accepted parameter name.
    const namePattern = args.query;
    // 3-tier ranked path when caller passed just `query` (no filter args).
    if (namePattern && hasOnlyQuery(args)) {
        return runRankedSearch(ctx, namePattern, args.limit ?? 100);
    }
    return runFilteredSearch(args, ctx, namePattern);
}
function formatTraceDepthGroup(depth, nodes) {
    const lines = [`Depth ${depth}:`];
    for (const node of nodes) {
        const risk = node.risk ? ` [${node.risk}]` : '';
        const sig = node.signature ? ` ${node.signature}` : '';
        lines.push(`  ${node.label} ${node.name}${sig}${risk}`);
        if (node.filePath)
            lines.push(`    ${node.filePath}:${node.startLine}`);
    }
    lines.push('');
    return lines;
}
function groupNodesByDepth(nodes) {
    const byDepth = new Map();
    for (const node of nodes) {
        const group = byDepth.get(node.depth) ?? [];
        group.push(node);
        byDepth.set(node.depth, group);
    }
    return byDepth;
}
function resolveDirection(raw) {
    if (raw === 'callers')
        return 'inbound';
    if (raw === 'callees')
        return 'outbound';
    if (raw === 'inbound' || raw === 'outbound' || raw === 'both')
        return raw;
    return 'both';
}
function formatTraceResult(result, functionName) {
    if (!result.startNode)
        return `Function "${functionName}" not found in the graph.`;
    const lines = [`Trace from: ${result.startNode.label} ${result.startNode.name}`];
    if (result.startNode.signature)
        lines.push(`  Signature: ${result.startNode.signature}`);
    if (result.startNode.filePath)
        lines.push(`  File: ${result.startNode.filePath}:${result.startNode.startLine}`);
    lines.push('', `${result.totalNodes} connected nodes found${result.truncated ? ' (truncated at 200)' : ''}:`, '');
    const byDepth = groupNodesByDepth(result.nodes);
    for (const [depth, nodes] of Array.from(byDepth.entries()).sort((a, b) => a[0] - b[0])) {
        lines.push(...formatTraceDepthGroup(depth, nodes));
    }
    if (result.impactSummary)
        lines.push(result.impactSummary);
    return truncate(lines.join('\n'));
}
export async function handleTraceCallPath(args, queryEngine) {
    // Wave 70 Phase B3: `function_name` deprecated alias dropped. `symbol` only.
    const functionName = args.symbol;
    if (!functionName) {
        return "Error: missing required parameter 'symbol'";
    }
    const minConfidence = args.min_confidence ?? 0;
    const result = queryEngine.traceCallPath({
        functionName,
        direction: resolveDirection(args.direction),
        depth: Math.min(Math.max(args.depth ?? 3, 1), 5),
        riskLabels: args.risk_labels ?? false,
        minConfidence: minConfidence > 0 ? minConfidence : undefined,
    });
    return formatTraceResult(result, functionName);
}
// ─── Tool 11: detect_changes handler ─────────────────────────────────────────
//
// Wave 70 Phase B1+B2: returns CallToolResult envelope with structuredContent.
// The text format mirrors the pre-Wave-70 string output for human readers.
function buildDetectChangesLines(result) {
    const lines = [
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
            lines.push(`  [${caller.risk}] ${caller.label} ${caller.name} (depth ${caller.depth}) -- ${caller.filePath}`);
        }
        lines.push('');
    }
    lines.push('Risk summary:');
    for (const [level, count] of Object.entries(result.riskSummary)) {
        if (count > 0)
            lines.push(`  ${level}: ${count}`);
    }
    return lines;
}
export async function handleDetectChanges(args, queryEngine) {
    const rawMinConf = args.min_confidence ?? 0;
    const result = await queryEngine.detectChanges({
        scope: args.scope ?? 'all',
        baseBranch: args.base_branch,
        depth: Math.min(Math.max(args.depth ?? 3, 1), 5),
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
async function handleAdrGet(proj, ctx) {
    const adr = ctx.db.getAdr(proj);
    if (!adr)
        return `No ADR found for project "${proj}".`;
    return truncate(adr.summary);
}
async function handleAdrStore(proj, args, ctx) {
    const content = args.content;
    if (!content)
        return 'Error: content is required for store mode.';
    if (content.length > 8000)
        return 'Error: ADR content exceeds 8000 character limit.';
    ctx.db.upsertAdr({
        project: proj,
        summary: content,
        source_hash: '',
        created_at: Date.now(),
        updated_at: Date.now(),
    });
    return `ADR stored for project "${proj}".`;
}
async function handleAdrUpdate(proj, args, ctx) {
    const sections = args.sections;
    if (!sections)
        return 'Error: sections object is required for update mode.';
    const validSections = ['PURPOSE', 'STACK', 'ARCHITECTURE', 'PATTERNS', 'TRADEOFFS', 'PHILOSOPHY'];
    for (const key of Object.keys(sections)) {
        if (!validSections.includes(key)) {
            return `Error: invalid section "${key}". Valid: ${validSections.join(', ')}`;
        }
    }
    const existing = ctx.db.getAdr(proj);
    let currentSections = {};
    if (existing) {
        try {
            currentSections = JSON.parse(existing.summary);
        }
        catch {
            currentSections = {};
        }
    }
    Object.assign(currentSections, sections);
    const merged = JSON.stringify(currentSections, null, 2);
    if (merged.length > 8000)
        return 'Error: merged ADR exceeds 8000 character limit.';
    ctx.db.upsertAdr({
        project: proj,
        summary: merged,
        source_hash: '',
        created_at: existing?.created_at ?? Date.now(),
        updated_at: Date.now(),
    });
    return `ADR updated for project "${proj}". Sections updated: ${Object.keys(sections).join(', ')}`;
}
export async function handleManageAdr(args, ctx) {
    const proj = args.project ?? ctx.projectName;
    // ADR storage is project-level by design (see Wave 20 Decision 4). Per-ID
    // targeting is not supported and was never wired through. If a consumer
    // needs per-ID retrieval, file a focused follow-up with the use case.
    const mode = args.mode;
    if (!mode) {
        return "Error: missing required parameter 'mode'";
    }
    switch (mode) {
        case 'list': {
            const adrs = ctx.db.listAdrs();
            if (adrs.length === 0)
                return 'No ADRs stored.';
            return truncate(adrs.map((a) => `${a.project}: updated ${new Date(a.updated_at).toISOString()}`).join('\n'));
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
function formatQueryResultText(result) {
    if (result.rows.length === 0)
        return 'No results.';
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
export async function handleQueryGraph(args, cypherEngine) {
    const queryResult = assertString(args, 'query');
    if (!queryResult.ok)
        return textResult(queryResult.error, { isError: true });
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
//# sourceMappingURL=mcpToolHandlerHelpers.js.map
/**
 * mcpToolHandlerStructured.ts — Wave 70 Phase B1+B2 handlers that return
 * the MCP `CallToolResult` envelope with `structuredContent` alongside text.
 *
 * Split out of `mcpToolHandlerDefs.ts` to satisfy the 300-line file cap.
 *
 * Tools covered here: `index_status`, `get_architecture`. Other naturally
 * structured tools live in `mcpToolHandlerHelpers.ts` (`handleQueryGraph`,
 * `handleDetectChanges`).
 */
import { textResult } from './types.js';
import { truncate } from './mcpToolHandlerHelpers.js';
export function readParseAnomalies(projectName, ctx) {
    try {
        const value = ctx.db.getGraphMetadata(`parse_anomalies:${projectName}`);
        if (!value)
            return { count: 0, files: [] };
        // Stored shape uses `files` (v0.2.2+). Fall back to `samples` for DB rows
        // written by older builds (pre-rename) so a cold-start reindex isn't required.
        const parsed = JSON.parse(value);
        const files = Array.isArray(parsed.files)
            ? parsed.files
            : Array.isArray(parsed.samples)
                ? parsed.samples
                : [];
        return {
            count: typeof parsed.count === 'number' ? parsed.count : 0,
            files,
        };
    }
    catch {
        return { count: 0, files: [] };
    }
}
function getParseAnomaliesLines(anomalies) {
    if (anomalies.count === 0) {
        return ['', 'Parse anomalies: 0 file(s) with no definitions'];
    }
    const lines = [`Parse anomalies: ${anomalies.count} file(s) with no definitions`];
    for (const sample of anomalies.files) {
        lines.push(`  - ${sample}`);
    }
    return ['', ...lines];
}
// ─── index_status handler ─────────────────────────────────────────────────────
function resolveProjectName(args, ctx) {
    return (args.project ??
        args.project_name ??
        ctx.projectName);
}
function buildIndexStatusLines(input) {
    return [
        `Project: ${input.name}`,
        `Root: ${input.project.root_path}`,
        `Indexed: ${new Date(input.project.indexed_at).toISOString()}`,
        `Total nodes: ${input.project.node_count}`,
        `Total edges: ${input.project.edge_count}`,
        '',
        'Node counts by label:',
        ...Object.entries(input.nodeCounts).map(([label, count]) => `  ${label}: ${count}`),
        '',
        'Edge counts by type:',
        ...Object.entries(input.edgeCounts).map(([type, count]) => `  ${type}: ${count}`),
        ...getParseAnomaliesLines(input.anomalies),
    ];
}
export async function handleIndexStatus(args, ctx) {
    const name = resolveProjectName(args, ctx);
    const project = ctx.db.getProject(name);
    if (!project) {
        return textResult(`Project "${name}" is not indexed. Run index_repository first.`, {
            isError: true,
            structuredContent: { project: name, indexed: false },
        });
    }
    const nodeCounts = ctx.db.getNodeLabelCounts(name);
    const edgeCounts = ctx.db.getEdgeTypeCounts(name);
    const anomalies = readParseAnomalies(name, ctx);
    // Derive the authoritative totals from the live per-label/per-type breakdowns
    // rather than the cached project.node_count/edge_count. This guarantees the
    // top-line and the breakdown can never disagree — even if the cache is stale
    // (e.g. a no-op incremental run that skips finalizeIndex).
    const totalNodes = Object.values(nodeCounts).reduce((sum, n) => sum + n, 0);
    const totalEdges = Object.values(edgeCounts).reduce((sum, n) => sum + n, 0);
    // Build the status lines using the live-derived totals via an inline project
    // shape that overrides the cached counts.
    const projectForLines = {
        root_path: project.root_path,
        indexed_at: project.indexed_at,
        node_count: totalNodes,
        edge_count: totalEdges,
    };
    const lines = buildIndexStatusLines({ name, project: projectForLines, nodeCounts, edgeCounts, anomalies });
    return textResult(truncate(lines.join('\n')), {
        structuredContent: {
            project: name,
            indexed: true,
            root: project.root_path,
            indexedAt: project.indexed_at,
            totalNodes,
            totalEdges,
            nodeCountsByLabel: nodeCounts,
            edgeCountsByType: edgeCounts,
            parseAnomalies: anomalies,
        },
    });
}
// ─── get_architecture handler ─────────────────────────────────────────────────
export async function handleGetArchitecture(args, ctx) {
    const aspects = args.aspects ?? ['all'];
    const result = ctx.queryEngine.getArchitecture(aspects);
    const lines = [`Architecture: ${result.projectName}`, ''];
    for (const [aspect, content] of Object.entries(result.aspects)) {
        lines.push(`## ${aspect}`, content, '');
    }
    return textResult(truncate(lines.join('\n')), {
        structuredContent: {
            project: result.projectName,
            aspects: result.aspects,
        },
    });
}
//# sourceMappingURL=mcpToolHandlerStructured.js.map
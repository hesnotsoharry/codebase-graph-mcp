/**
 * mcpToolHandlerSearch.ts — search_graph helpers extracted from
 * mcpToolHandlerHelpers.ts to keep handleSearchGraph under complexity 10.
 *
 * Wave 66: 3-tier ranked search (exact / prefix / substring) is preferred
 * when only `query` is supplied. The full filter path (label, file_pattern,
 * relationship, etc.) keeps the original substring-only behaviour.
 */
const MAX_OUTPUT_CHARS = 8000;
function truncate(text) {
    if (text.length <= MAX_OUTPUT_CHARS)
        return text;
    return text.slice(0, MAX_OUTPUT_CHARS) + '\n... (output truncated at 8000 chars)';
}
const FILTER_KEYS = [
    'label',
    'file_pattern',
    'relationship',
    'direction',
    'min_degree',
    'max_degree',
    'exclude_entry_points',
    'case_sensitive',
    'project',
    'offset',
];
export function hasOnlyQuery(args) {
    return FILTER_KEYS.every((k) => {
        // eslint-disable-next-line security/detect-object-injection -- k from FILTER_KEYS literal
        const v = args[k];
        return v === undefined;
    });
}
export function formatSearchNode(node) {
    const props = node.props;
    const sig = props.signature ? ` ${props.signature}` : '';
    const loc = node.file_path
        ? `${node.file_path}${node.start_line ? ':' + node.start_line : ''}`
        : '';
    const lines = [`${node.label} ${node.name}${sig}`];
    if (loc)
        lines.push(`  ${loc}`);
    lines.push(`  qualified: ${node.qualified_name}`, '');
    return lines;
}
function rankLabel(rank) {
    if (rank === 0)
        return 'Exact matches:';
    if (rank === 1)
        return 'Prefix matches:';
    return 'Substring matches:';
}
export function runRankedSearch(ctx, query, limit) {
    const ranked = ctx.db.searchNodesRanked(ctx.projectName, query, limit);
    if (ranked.length === 0)
        return 'No matching nodes found.';
    const lines = [`Found ${ranked.length} ranked nodes:`, ''];
    let lastRank = -1;
    for (const node of ranked) {
        if (node.rank !== lastRank) {
            lines.push(rankLabel(node.rank));
            lastRank = node.rank;
        }
        lines.push(...formatSearchNode(node));
    }
    return truncate(lines.join('\n'));
}
export function runFilteredSearch(args, ctx, namePattern) {
    const result = ctx.db.searchNodes({
        project: args.project ?? ctx.projectName,
        label: args.label,
        namePattern,
        filePath: args.file_pattern,
        relationship: args.relationship,
        direction: args.direction,
        minDegree: args.min_degree,
        maxDegree: args.max_degree,
        excludeEntryPoints: args.exclude_entry_points,
        caseSensitive: args.case_sensitive,
        limit: args.limit ?? 100,
        offset: args.offset ?? 0,
    });
    if (result.nodes.length === 0)
        return 'No matching nodes found.';
    const lines = [`Found ${result.total} nodes (showing ${result.nodes.length}):`, ''];
    for (const node of result.nodes)
        lines.push(...formatSearchNode(node));
    if (result.has_more) {
        const nextOffset = (args.offset ?? 0) + result.nodes.length;
        lines.push(`... ${result.total - result.nodes.length} more results. Use offset=${nextOffset} to see more.`);
    }
    return truncate(lines.join('\n'));
}
//# sourceMappingURL=mcpToolHandlerSearch.js.map
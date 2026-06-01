/**
 * types.ts — Local type definitions for the standalone codebase-graph-mcp package.
 *
 * Replaces imports from `../internalMcp/internalMcpTypes` (IDE-internal).
 * Contains the MCP tool result envelope types needed by the graph handler files.
 */
/** Wraps a plain text reply into the MCP envelope. */
export function textResult(text, opts) {
    const result = { content: [{ type: 'text', text }] };
    if (opts?.isError)
        result.isError = true;
    if (opts?.structuredContent)
        result.structuredContent = opts.structuredContent;
    return result;
}
//# sourceMappingURL=types.js.map
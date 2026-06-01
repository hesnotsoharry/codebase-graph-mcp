/**
 * types.ts — Local type definitions for the standalone codebase-graph-mcp package.
 *
 * Replaces imports from `../internalMcp/internalMcpTypes` (IDE-internal).
 * Contains the MCP tool result envelope types needed by the graph handler files.
 */
export interface McpTextContent {
    type: 'text';
    text: string;
}
export type McpContentBlock = McpTextContent;
export interface McpToolResult {
    content: McpContentBlock[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
}
/** Wraps a plain text reply into the MCP envelope. */
export declare function textResult(text: string, opts?: {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
}): McpToolResult;
export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: Record<string, unknown>, workspaceRoot: string) => Promise<McpToolResult>;
}
//# sourceMappingURL=types.d.ts.map
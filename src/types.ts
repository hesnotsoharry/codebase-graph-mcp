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
export function textResult(
  text: string,
  opts?: { isError?: boolean; structuredContent?: Record<string, unknown> },
): McpToolResult {
  const result: McpToolResult = { content: [{ type: 'text', text }] };
  if (opts?.isError) result.isError = true;
  if (opts?.structuredContent) result.structuredContent = opts.structuredContent;
  return result;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  handler: (args: Record<string, unknown>, workspaceRoot: string) => Promise<McpToolResult>;
}

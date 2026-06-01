/**
 * mcpToolHandlers.ts -- MCP tool definitions for the codebase knowledge graph.
 *
 * Exports a `createGraphMcpTools(context)` function that returns 15 McpToolDefinition
 * objects (14 graph tools + ping health-check). M-28 Phase 3 adds find_typeof_references
 * → 16 total. Each handler returns formatted plain text (not JSON), includes qualified
 * names and file:line locations, and truncates output at ~8000 chars.
 *
 * NOTE: file is over the 300-line max-lines limit. The TOOL_SCHEMAS constant
 * (lines ~36-200) is mostly inline JSON-schema declarations; splitting them
 * into a separate module is the natural fix. Tracked as Wave 20 Tier-3
 * follow-up: roadmap/follow-ups/2026-05-26-mcptoolhandlers-over-cap.md.
 */
import type { McpToolDefinition } from './types';
import type { GraphToolContext } from './graphTypes';
export type { GraphToolContext };
export declare function createGraphMcpTools(context: GraphToolContext): McpToolDefinition[];
//# sourceMappingURL=mcpToolHandlers.d.ts.map
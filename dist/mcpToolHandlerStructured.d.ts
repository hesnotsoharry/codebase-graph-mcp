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
import type { McpToolResult } from './types';
import type { GraphToolContext } from './graphTypes';
export interface ParseAnomalies {
    count: number;
    files: string[];
    /**
     * Informational secondary metric: files that parsed cleanly but emitted
     * zero symbols. May indicate extractor gaps, not parse failures.
     * Added in v0.4.x — absent in DB rows from older builds (defaults to empty).
     */
    filesWithoutSymbols: {
        count: number;
        files: string[];
    };
}
export declare function readParseAnomalies(projectName: string, ctx: GraphToolContext): ParseAnomalies;
export declare function handleIndexStatus(args: Record<string, unknown>, ctx: GraphToolContext): Promise<McpToolResult>;
export declare function handleGetArchitecture(args: Record<string, unknown>, ctx: GraphToolContext): Promise<McpToolResult>;
//# sourceMappingURL=mcpToolHandlerStructured.d.ts.map
/**
 * mcpToolHandlerHelpers.ts — Handler implementations extracted from mcpToolHandlers.ts
 * to keep the factory function and each handler under the max-lines-per-function limit.
 */
import type { McpToolResult } from './types';
import type { CypherEngine } from './cypherEngine';
import type { GraphToolContext } from './graphTypes';
import type { QueryEngine } from './queryEngine';
export declare function truncate(text: string): string;
export declare function handleSearchGraph(args: Record<string, unknown>, ctx: GraphToolContext): Promise<string>;
export declare function handleTraceCallPath(args: Record<string, unknown>, queryEngine: QueryEngine): Promise<string>;
export declare function handleDetectChanges(args: Record<string, unknown>, queryEngine: QueryEngine): Promise<McpToolResult>;
export declare function handleManageAdr(args: Record<string, unknown>, ctx: GraphToolContext): Promise<string>;
export declare function handleQueryGraph(args: Record<string, unknown>, cypherEngine: CypherEngine): Promise<McpToolResult>;
//# sourceMappingURL=mcpToolHandlerHelpers.d.ts.map
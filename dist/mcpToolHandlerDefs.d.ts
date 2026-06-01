/**
 * mcpToolHandlerDefs.ts — Tool handler implementations extracted from
 * mcpToolHandlers.ts to keep the factory function under the line limit.
 */
import type { GraphToolContext } from './mcpToolHandlers';
export { handleGetArchitecture, handleIndexStatus } from './mcpToolHandlerStructured';
export declare function handleIndexRepository(args: Record<string, unknown>, ctx: GraphToolContext): Promise<string>;
export declare function handleListProjects(ctx: GraphToolContext): Promise<string>;
export declare function handleDeleteProject(args: Record<string, unknown>, ctx: GraphToolContext): Promise<string>;
export declare function handleGetGraphSchema(ctx: GraphToolContext): Promise<string>;
export declare function handleSearchCode(args: Record<string, unknown>, ctx: GraphToolContext): Promise<string>;
export declare function handleGetCodeSnippet(args: Record<string, unknown>, ctx: GraphToolContext): Promise<string>;
export declare function handleIngestTraces(args: Record<string, unknown>, ctx: GraphToolContext): Promise<string>;
//# sourceMappingURL=mcpToolHandlerDefs.d.ts.map
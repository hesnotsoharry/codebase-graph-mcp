/**
 * mcpToolHandlerTypeof.ts — Handler implementation for the `find_typeof_references` tool.
 *
 * Queries the graph for TYPEOF_REFERENCES edges where the target symbol name
 * matches `symbol_name`. Optionally scoped to `project_name`.
 *
 * Returns a formatted list of { file, line, context, pattern } rows, one per
 * edge, sorted by file path and line number.
 */
import type { GraphToolContext } from './mcpToolHandlers';
export declare function handleFindTypeofReferences(ctx: GraphToolContext, args: Record<string, unknown>): Promise<string>;
//# sourceMappingURL=mcpToolHandlerTypeof.d.ts.map
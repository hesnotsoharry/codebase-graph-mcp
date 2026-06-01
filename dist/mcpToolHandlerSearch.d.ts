/**
 * mcpToolHandlerSearch.ts — search_graph helpers extracted from
 * mcpToolHandlerHelpers.ts to keep handleSearchGraph under complexity 10.
 *
 * Wave 66: 3-tier ranked search (exact / prefix / substring) is preferred
 * when only `query` is supplied. The full filter path (label, file_pattern,
 * relationship, etc.) keeps the original substring-only behaviour.
 */
import type { GraphToolContext } from './mcpToolHandlers';
export declare function hasOnlyQuery(args: Record<string, unknown>): boolean;
interface SearchableNode {
    label: string;
    name: string;
    file_path?: string | null;
    start_line?: number | null;
    qualified_name: string;
    props: unknown;
}
export declare function formatSearchNode(node: SearchableNode): string[];
export declare function runRankedSearch(ctx: GraphToolContext, query: string, limit: number): string;
export declare function runFilteredSearch(args: Record<string, unknown>, ctx: GraphToolContext, namePattern: string | undefined): string;
export {};
//# sourceMappingURL=mcpToolHandlerSearch.d.ts.map
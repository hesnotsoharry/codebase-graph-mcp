/**
 * graphControllerCompatQueries.ts — Query method implementations for the
 * GraphControllerCompat shim. Each function delegates to System 2 and
 * returns a System 1–shaped result via adapters.
 *
 * Kept in a separate file so graphControllerCompat.ts stays under 300 lines.
 */
import type { CypherEngine } from './cypherEngine';
import { toSystem1GraphNode } from './graphControllerCompatAdapters';
import type { GraphDatabase } from './graphDatabase';
import type { CallPathResult, ChangeDetectionResult, CodeSnippetResult, GraphSchema, SearchResult } from './graphTypes';
import type { ArchitectureView } from './graphTypes';
import type { QueryEngine } from './queryEngine';
export declare function compatSearchGraph(db: GraphDatabase, projectName: string, query: string, limit?: number): SearchResult[];
export declare function compatQueryGraph(cypherEngine: CypherEngine, query: string): Array<Record<string, unknown>>;
export declare function compatTraceCallPath(queryEngine: QueryEngine, fromName: string, toName: string, maxDepth?: number): CallPathResult;
export declare function compatGetArchitecture(queryEngine: QueryEngine, aspects?: string[]): ArchitectureView;
export declare function compatGetCodeSnippet(db: GraphDatabase, queryEngine: QueryEngine, projectName: string, symbolId: string): Promise<CodeSnippetResult | null>;
export declare function compatDetectChanges(queryEngine: QueryEngine): Promise<ChangeDetectionResult>;
export declare function compatDetectChangesForSession(db: GraphDatabase, projectName: string, _sessionId: string, files: string[]): ChangeDetectionResult;
export declare function compatGetGraphSchema(queryEngine: QueryEngine): GraphSchema;
export interface CompatSearchCodeOptions {
    projectRoot: string;
    db: GraphDatabase;
    projectName: string;
    pattern: string;
    opts?: {
        fileGlob?: string;
        maxResults?: number;
    };
}
export declare function compatSearchCode({ projectRoot, db, projectName, pattern, opts, }: CompatSearchCodeOptions): Promise<Array<{
    filePath: string;
    line: number;
    match: string;
}>>;
export declare function compatGetIndexStatus(db: GraphDatabase, projectName: string, projectRoot: string, initialized: boolean): import('./graphTypes').IndexStatus;
export { toSystem1GraphNode };
//# sourceMappingURL=graphControllerCompatQueries.d.ts.map
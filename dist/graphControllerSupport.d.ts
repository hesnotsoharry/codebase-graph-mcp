/**
 * graphControllerSupport.ts — Singleton management for the codebase graph
 * engine. Post-Phase-E: System 2 only — all acquire/release paths delegate
 * to graphControllerCompatRegistry.
 */
import type { ArchitectureView, CallPathResult, ChangeDetectionResult, CodeSnippetResult, GraphSchema, GraphToolContext, IndexStatus, SearchResult } from './graphTypes';
export interface GraphControllerLike {
    readonly rootPath: string;
    getStatus(): IndexStatus;
    indexStatus: () => IndexStatus;
    getGraphToolContext(): GraphToolContext;
    onSessionStart(): void;
    onGitCommit(): void;
    onFileChange(paths: string[]): void;
    indexRepository(opts: {
        projectRoot: string;
        projectName: string;
        incremental: boolean;
    }): Promise<{
        success: boolean;
    }>;
    listProjects(): string[];
    deleteProject(projectRoot: string): {
        success: boolean;
    };
    detectChanges(): Promise<ChangeDetectionResult>;
    detectChangesForSession(sessionId: string, files: string[]): Promise<ChangeDetectionResult>;
    getArchitecture(aspects?: string[]): ArchitectureView;
    getCodeSnippet(symbolId: string): Promise<CodeSnippetResult | null>;
    getGraphSchema(): GraphSchema;
    ingestTraces(traces: unknown[]): {
        success: boolean;
        ingested: number;
    };
    manageAdr(action: 'list' | 'get' | 'create' | 'update' | 'delete', id?: string): unknown;
    queryGraph(query: string): Array<Record<string, unknown>>;
    searchCode(pattern: string, opts?: {
        fileGlob?: string;
        maxResults?: number;
    }): Promise<Array<{
        filePath: string;
        line: number;
        match: string;
    }>>;
    searchGraph(query: string, limit?: number): SearchResult[];
    traceCallPath(fromId: string, toId: string, maxDepth?: number): CallPathResult;
    dispose(): Promise<void>;
}
/** Called once at startup with the shared GraphDatabase instance. */
export declare function setSystem2Db(db: unknown): void;
/** Register controller as the default-root instance. */
export declare function setGraphController(controller: GraphControllerLike): void;
/**
 * Returns the default-root controller, or null if none is registered.
 * Callers without a specific root context use this.
 */
export declare function getGraphController(): GraphControllerLike | null;
/** Returns the controller for a specific root, or null if not registered. */
export declare function getGraphControllerForRoot(root: string): GraphControllerLike | null;
/**
 * Acquire a GraphControllerCompat for root. Increments ref-count if already
 * acquired. Always delegates to graphControllerCompatRegistry (System 2).
 *
 * opts.sessionId: when provided the session's worktreePath (if active) is used
 * as the registry key so the graph is indexed against the isolated worktree
 * rather than the main project root.
 */
export declare function acquireGraphController(root: string, opts?: {
    sessionId?: string;
}): Promise<GraphControllerLike>;
/** Release a ref. Disposes the controller when ref-count reaches zero. */
export declare function releaseGraphController(root: string): Promise<void>;
//# sourceMappingURL=graphControllerSupport.d.ts.map
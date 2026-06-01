/**
 * graphControllerCompat.ts — Drop-in compatibility shim that exposes System 1's
 * GraphController interface while delegating all operations to System 2 internals.
 *
 * Consumers call getGraphController() / acquireGraphController() from
 * graphControllerCompatRegistry.ts and receive a GraphControllerCompat instance.
 * Every public method matches the System 1 GraphController surface exactly.
 */
import type { AutoSyncWatcher } from './autoSync';
import type { CypherEngine } from './cypherEngine';
import type { GraphDatabase } from './graphDatabase';
import type { ArchitectureView, CallPathResult, ChangeDetectionResult, CodeSnippetResult, GraphSchema, GraphToolContext, IndexStatus, SearchResult } from './graphTypes';
import type { IndexingWorkerClient } from './indexingWorkerClient';
import type { QueryEngine } from './queryEngine';
export interface CompatHandle {
    db: GraphDatabase;
    queryEngine: QueryEngine;
    cypherEngine: CypherEngine;
    workerClient: IndexingWorkerClient;
    watcher: AutoSyncWatcher | null;
    projectRoot: string;
    projectName: string;
}
export declare class GraphControllerCompat {
    readonly rootPath: string;
    private handle;
    private _initialized;
    constructor(handle: CompatHandle);
    getStatus(): IndexStatus;
    indexStatus: () => IndexStatus;
    getGraphToolContext(): GraphToolContext;
    onFileChange(paths?: string[]): void;
    onSessionStart(): void;
    onGitCommit(): void;
    dispose(): Promise<void>;
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
    searchGraph(query: string, limit?: number): SearchResult[];
    queryGraph(query: string): Array<Record<string, unknown>>;
    traceCallPath(fromId: string, toId: string, maxDepth?: number): CallPathResult;
    getArchitecture(aspects?: string[]): ArchitectureView;
    getCodeSnippet(symbolId: string): Promise<CodeSnippetResult | null>;
    getGraphSchema(): GraphSchema;
    detectChanges(): Promise<ChangeDetectionResult>;
    detectChangesForSession(sessionId: string, files: string[]): Promise<ChangeDetectionResult>;
    searchCode(pattern: string, opts?: {
        fileGlob?: string;
        maxResults?: number;
    }): Promise<Array<{
        filePath: string;
        line: number;
        match: string;
    }>>;
    ingestTraces(traces: unknown[]): {
        success: boolean;
        ingested: number;
    };
    manageAdr(action: 'list' | 'get' | 'create' | 'update' | 'delete', id?: string): unknown;
}
//# sourceMappingURL=graphControllerCompat.d.ts.map
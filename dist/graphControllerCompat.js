/**
 * graphControllerCompat.ts — Drop-in compatibility shim that exposes System 1's
 * GraphController interface while delegating all operations to System 2 internals.
 *
 * Consumers call getGraphController() / acquireGraphController() from
 * graphControllerCompatRegistry.ts and receive a GraphControllerCompat instance.
 * Every public method matches the System 1 GraphController surface exactly.
 */
import path from 'path';
import { consoleErrorLogger as log } from './loggerInterface.js';
import { compatDetectChanges, compatDetectChangesForSession, compatGetArchitecture, compatGetCodeSnippet, compatGetGraphSchema, compatGetIndexStatus, compatQueryGraph, compatSearchCode, compatSearchGraph, compatTraceCallPath, } from './graphControllerCompatQueries.js';
// ─── GraphControllerCompat ────────────────────────────────────────────────────
export class GraphControllerCompat {
    rootPath;
    handle;
    _initialized = false;
    constructor(handle) {
        this.handle = handle;
        this.rootPath = handle.projectRoot;
        this._initialized = handle.db.getProject(handle.projectName) !== null;
    }
    // ─── Status & context ──────────────────────────────────────────────────
    getStatus() {
        return compatGetIndexStatus(this.handle.db, this.handle.projectName, this.handle.projectRoot, this._initialized);
    }
    indexStatus = this.getStatus.bind(this);
    getGraphToolContext() {
        const { db, queryEngine, cypherEngine, workerClient, projectRoot, projectName } = this.handle;
        return {
            db,
            queryEngine,
            cypherEngine,
            pipeline: {
                index: (options) => workerClient.runIndex({ ...options, onProgress: () => { } }),
            },
            projectRoot,
            projectName,
        };
    }
    // ─── Lifecycle ──────────────────────────────────────────────────────────
    onFileChange(paths = []) {
        this.handle.watcher?.onFileChange(paths);
    }
    onSessionStart() {
        this._initialized = true;
        this.handle.watcher?.onSessionStart();
    }
    onGitCommit() {
        this.handle.watcher?.onGitCommit();
    }
    async dispose() {
        this._initialized = false;
        log.info(`[compat] dispose ${this.handle.projectName}`);
    }
    // ─── Indexing ────────────────────────────────────────────────────────────
    async indexRepository(opts) {
        try {
            const result = await this.handle.workerClient.runIndex({
                projectRoot: opts.projectRoot,
                projectName: opts.projectName,
                incremental: opts.incremental,
            });
            if (result.success)
                this._initialized = true;
            return { success: result.success };
        }
        catch (err) {
            log.error('[compat] indexRepository error:', err);
            return { success: false };
        }
    }
    listProjects() {
        return this._initialized ? [this.rootPath] : [];
    }
    deleteProject(projectRoot) {
        if (projectRoot !== this.rootPath)
            return { success: false };
        this.handle.db.deleteProject(this.handle.projectName);
        this._initialized = false;
        return { success: true };
    }
    // ─── Query methods ───────────────────────────────────────────────────────
    searchGraph(query, limit) {
        return compatSearchGraph(this.handle.db, this.handle.projectName, query, limit);
    }
    queryGraph(query) {
        return compatQueryGraph(this.handle.cypherEngine, query);
    }
    traceCallPath(fromId, toId, maxDepth) {
        const fromName = extractName(fromId);
        const toName = extractName(toId);
        return compatTraceCallPath(this.handle.queryEngine, fromName, toName, maxDepth);
    }
    getArchitecture(aspects) {
        return compatGetArchitecture(this.handle.queryEngine, aspects);
    }
    async getCodeSnippet(symbolId) {
        return compatGetCodeSnippet(this.handle.db, this.handle.queryEngine, this.handle.projectName, symbolId);
    }
    getGraphSchema() {
        return compatGetGraphSchema(this.handle.queryEngine);
    }
    async detectChanges() {
        return compatDetectChanges(this.handle.queryEngine);
    }
    async detectChangesForSession(sessionId, files) {
        return compatDetectChangesForSession(this.handle.db, this.handle.projectName, sessionId, files);
    }
    async searchCode(pattern, opts) {
        return compatSearchCode({
            projectRoot: this.handle.projectRoot,
            db: this.handle.db,
            projectName: this.handle.projectName,
            pattern,
            opts,
        });
    }
    // ─── Pass-through helpers ────────────────────────────────────────────────
    ingestTraces(traces) {
        if (!Array.isArray(traces))
            return { success: false, ingested: 0 };
        const edges = traces.filter(isTraceInput).map((t) => ({
            project: this.handle.projectName,
            source_id: t.fromId,
            target_id: t.toId,
            type: (t.type ?? 'HTTP_CALLS'),
            props: {},
        }));
        this.handle.db.insertEdges(edges);
        return { success: true, ingested: edges.length };
    }
    manageAdr(action, id) {
        const adrDir = path.join(this.rootPath, 'docs', 'adr');
        const messages = new Map([
            ['list', 'ADR directory: ' + adrDir],
            ['get', 'ADR not found'],
            ['create', 'ADR creation requires file system write — use files:writeFile'],
            ['update', 'ADR update requires file system write — use files:writeFile'],
            ['delete', 'ADR deletion requires file system operation'],
        ]);
        const msg = messages.get(action);
        return msg
            ? { success: true, ...(id ? { id } : {}), message: msg }
            : { success: false, error: 'Unknown ADR action' };
    }
}
// ─── Private helpers ──────────────────────────────────────────────────────────
/**
 * Extract the symbol name from either a S1 id (`path::name::type::line`)
 * or treat the whole string as a name (S2 qualified_name or bare name).
 */
function extractName(id) {
    if (id.includes('::')) {
        const parts = id.split('::');
        return parts[1] ?? id;
    }
    // S2 qualified_name: last segment after the last '.'
    const dotIdx = id.lastIndexOf('.');
    return dotIdx >= 0 ? id.slice(dotIdx + 1) : id;
}
function isTraceInput(t) {
    return (typeof t === 'object' &&
        t !== null &&
        typeof t.fromId === 'string' &&
        typeof t.toId === 'string');
}
//# sourceMappingURL=graphControllerCompat.js.map
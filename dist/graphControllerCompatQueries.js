/**
 * graphControllerCompatQueries.ts — Query method implementations for the
 * GraphControllerCompat shim. Each function delegates to System 2 and
 * returns a System 1–shaped result via adapters.
 *
 * Kept in a separate file so graphControllerCompat.ts stays under 300 lines.
 */
import fs from 'fs/promises';
import path from 'path';
import { consoleErrorLogger as log } from './loggerInterface.js';
import { toSystem1ArchitectureView, toSystem1CallPathResult, toSystem1ChangeDetectionResult, toSystem1ChangeDetectionResultFromSession, toSystem1CodeSnippetResult, toSystem1GraphNode, toSystem1GraphSchema, toSystem1SearchResult, } from './graphControllerCompatAdapters.js';
// ─── M3 — searchGraph ────────────────────────────────────────────────────────
export function compatSearchGraph(db, projectName, query, limit = 20) {
    const result = db.searchNodes({
        project: projectName,
        namePattern: query,
        limit: limit * 2, // over-fetch to allow sorting
    });
    return result.nodes
        .map((node) => toSystem1SearchResult(node, query))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}
// ─── queryGraph ───────────────────────────────────────────────────────────────
export function compatQueryGraph(cypherEngine, query) {
    try {
        const result = cypherEngine.execute(query);
        return result.rows;
    }
    catch (err) {
        log.warn('[compat] queryGraph error:', err);
        return [];
    }
}
// ─── M4 — traceCallPath ──────────────────────────────────────────────────────
export function compatTraceCallPath(queryEngine, fromName, toName, maxDepth = 5) {
    const clampedDepth = Math.min(Math.max(maxDepth, 1), 5);
    const traceResult = queryEngine.traceCallPath({
        functionName: fromName,
        direction: 'both',
        depth: clampedDepth,
        riskLabels: false,
    });
    return toSystem1CallPathResult(traceResult, toName);
}
// ─── M2 — getArchitecture ────────────────────────────────────────────────────
export function compatGetArchitecture(queryEngine, aspects) {
    const s2Aspects = aspects?.length
        ? aspects
        : ['all'];
    const result = queryEngine.getArchitecture(s2Aspects);
    return toSystem1ArchitectureView(result);
}
// ─── M7 — getCodeSnippet ─────────────────────────────────────────────────────
export async function compatGetCodeSnippet(db, queryEngine, projectName, symbolId) {
    // symbolId may be a S1 id (path::name::type::line) or a S2 qualified_name
    const s2Node = db.getNode(symbolId) ?? findNodeByS1Id(db, projectName, symbolId);
    if (!s2Node)
        return null;
    const content = queryEngine.getCodeSnippet(s2Node.id) ?? '';
    const outEdges = db.getOutboundEdges(s2Node.id);
    const inEdges = db.getInboundEdges(s2Node.id);
    const depIds = outEdges.map((e) => e.target_id);
    const dependentIds = inEdges.map((e) => e.source_id);
    return toSystem1CodeSnippetResult(content, s2Node, depIds, dependentIds);
}
function findNodeByS1Id(db, projectName, s1Id) {
    if (!s1Id.includes('::'))
        return null;
    const parts = s1Id.split('::');
    if (parts.length < 2)
        return null;
    const name = parts[1];
    const result = db.searchNodes({
        project: projectName,
        namePattern: name,
        caseSensitive: true,
        limit: 10,
    });
    return result.nodes.find((n) => n.name === name) ?? null;
}
// ─── M5 — detectChanges ──────────────────────────────────────────────────────
export async function compatDetectChanges(queryEngine) {
    try {
        const result = await queryEngine.detectChanges({ scope: 'all', depth: 3 });
        return toSystem1ChangeDetectionResult(result);
    }
    catch (err) {
        log.warn('[compat] detectChanges error:', err);
        return { changedFiles: [], affectedSymbols: [], blastRadius: 0 };
    }
}
// ─── detectChangesForSession ──────────────────────────────────────────────────
export function compatDetectChangesForSession(db, projectName, _sessionId, files) {
    const result = db.detectChangesForSession(projectName, files);
    return toSystem1ChangeDetectionResultFromSession(result);
}
// ─── getGraphSchema ───────────────────────────────────────────────────────────
export function compatGetGraphSchema(queryEngine) {
    return toSystem1GraphSchema(queryEngine.getGraphSchema());
}
export async function compatSearchCode({ projectRoot, db, projectName, pattern, opts, }) {
    const maxResults = opts?.maxResults ?? 100;
    const results = [];
    let regex;
    try {
        // eslint-disable-next-line security/detect-non-literal-regexp -- pattern is user-provided search query
        regex = new RegExp(pattern, 'gi');
    }
    catch {
        return results;
    }
    const fileNodes = db.getNodesByLabel(projectName, 'File');
    const fileGlob = opts?.fileGlob;
    for (const fileNode of fileNodes) {
        if (results.length >= maxResults)
            break;
        const filePath = fileNode.props.path;
        if (!filePath)
            continue;
        if (fileGlob && !matchGlob(filePath, fileGlob))
            continue;
        await searchFileLines({ projectRoot, filePath, regex, maxResults, results });
    }
    return results;
}
function matchGlob(filePath, glob) {
    const regexStr = glob
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{GLOBSTAR\}\}/g, '.*');
    try {
        // eslint-disable-next-line security/detect-non-literal-regexp -- glob is from caller's file filter
        const fullRe = new RegExp(`^${regexStr}$`);
        // eslint-disable-next-line security/detect-non-literal-regexp -- glob is from caller's file filter
        const partialRe = new RegExp(regexStr);
        return fullRe.test(filePath) || partialRe.test(filePath);
    }
    catch {
        return false;
    }
}
async function searchFileLines({ projectRoot, filePath, regex, maxResults, results, }) {
    const fullPath = path.join(projectRoot, filePath);
    let content;
    try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from indexed project files
        content = await fs.readFile(fullPath, 'utf-8');
    }
    catch {
        return;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        regex.lastIndex = 0;
        // eslint-disable-next-line security/detect-object-injection -- i is a numeric loop index
        if (regex.test(lines[i])) {
            // eslint-disable-next-line security/detect-object-injection -- i is a numeric loop index
            results.push({ filePath, line: i + 1, match: lines[i].trim() });
        }
    }
}
// ─── IndexStatus helper ───────────────────────────────────────────────────────
export function compatGetIndexStatus(db, projectName, projectRoot, initialized) {
    const project = db.getProject(projectName);
    // Read live counts — stored counts on the project row are only refreshed at the
    // end of finalizeIndex and can lag reality after incremental updates.
    const nodeCount = db.getNodeCount(projectName);
    const edgeCount = db.getEdgeCount(projectName);
    const fileNodes = db.getNodesByLabel(projectName, 'File');
    return {
        initialized,
        projectRoot,
        projectName,
        nodeCount,
        edgeCount,
        fileCount: fileNodes.length,
        lastIndexedAt: project?.indexed_at ?? 0,
        indexDurationMs: 0,
    };
}
// ─── toSystem1GraphNode re-export (convenience for compat class) ──────────────
export { toSystem1GraphNode };
//# sourceMappingURL=graphControllerCompatQueries.js.map
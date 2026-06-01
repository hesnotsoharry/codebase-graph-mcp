/**
 * queryEngine.ts — High-level query operations over the codebase graph.
 *
 * Provides BFS call-path tracing with risk classification, git-aware impact
 * analysis (blast radius), architecture overview computation, schema
 * introspection, grep-like code search, and source snippet retrieval.
 */
import fs from 'fs';
import path from 'path';
import { buildChangedSymbols, buildImpactedCallers, buildLayerMap, buildRiskSummaryFromNodes, CALL_EDGE_TYPES, classifyRisk, collectTraceEdges, deduplicateTraceResult, getGitChangedFiles, getNodeSignature, MAX_BFS_NODES, MAX_DEPTH, searchCodeFiles, SYMBOL_LABELS, } from './queryEngineSupport.js';
// ─── QueryEngine ──────────────────────────────────────────────────────────────
export class QueryEngine {
    db;
    projectName;
    projectRoot;
    constructor(db, projectName, projectRoot) {
        this.db = db;
        this.projectName = projectName;
        this.projectRoot = projectRoot;
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // trace_call_path
    // ═══════════════════════════════════════════════════════════════════════════
    traceCallPath(options) {
        const startNode = this.resolveStartNode(options.functionName);
        if (!startNode)
            return {
                startNode: null,
                nodes: [],
                edges: [],
                totalNodes: 0,
                truncated: false,
            };
        const clampedDepth = Math.min(Math.max(options.depth, 1), MAX_DEPTH);
        const acc = { results: [], traceEdges: [] };
        this.runTraceDirection(startNode, clampedDepth, options, acc);
        const partial = {
            startNode: {
                id: startNode.id,
                name: startNode.name,
                label: startNode.label,
                filePath: startNode.file_path,
                startLine: startNode.start_line,
                signature: getNodeSignature(startNode),
                depth: 0,
            },
            nodes: acc.results,
            edges: acc.traceEdges,
            totalNodes: acc.results.length,
            truncated: acc.results.length >= MAX_BFS_NODES,
        };
        const deduped = deduplicateTraceResult(partial);
        if (options.riskLabels)
            deduped.impactSummary = buildRiskSummaryFromNodes(deduped.nodes);
        return deduped;
    }
    resolveStartNode(functionName) {
        const candidates = this.db.searchNodes({
            project: this.projectName,
            namePattern: functionName,
            caseSensitive: true,
            limit: 50,
        });
        let matches = candidates.nodes.filter((n) => n.name === functionName);
        if (matches.length === 0) {
            const lower = functionName.toLowerCase();
            matches = candidates.nodes.filter((n) => n.name.toLowerCase() === lower);
        }
        return matches[0] ?? null;
    }
    collectBfsResults(bfsResults, options, acc) {
        for (const result of bfsResults) {
            const node = this.db.getNode(result.id);
            if (!node)
                continue;
            const traceNode = {
                id: node.id,
                name: node.name,
                label: node.label,
                filePath: node.file_path,
                startLine: node.start_line,
                signature: getNodeSignature(node),
                depth: result.depth,
            };
            if (options.riskLabels)
                traceNode.risk = classifyRisk(this.db, node, result.depth);
            acc.results.push(traceNode);
            collectTraceEdges(result.path, acc.traceEdges);
        }
    }
    runTraceDirection(startNode, clampedDepth, options, acc) {
        const directions = [];
        if (options.direction === 'both' || options.direction === 'outbound')
            directions.push('outbound');
        if (options.direction === 'both' || options.direction === 'inbound')
            directions.push('inbound');
        for (const direction of directions) {
            const bfsResults = this.db.bfsTraversal({
                startNodeId: startNode.id,
                edgeTypes: CALL_EDGE_TYPES,
                direction,
                maxDepth: clampedDepth,
                maxNodes: MAX_BFS_NODES,
                minConfidence: options.minConfidence,
            });
            this.collectBfsResults(bfsResults, options, acc);
        }
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // detect_changes
    // ═══════════════════════════════════════════════════════════════════════════
    async detectChanges(options) {
        const emptyResult = {
            changedFiles: [],
            changedSymbols: [],
            impactedCallers: [],
            riskSummary: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        };
        const changedFiles = await getGitChangedFiles(options, this.projectRoot);
        if (changedFiles.length === 0)
            return emptyResult;
        const changedSymbols = buildChangedSymbols(this.db, this.projectName, changedFiles);
        const clampedDepth = Math.min(Math.max(options.depth, 1), MAX_DEPTH);
        const classifyFn = (node, depth) => classifyRisk(this.db, node, depth);
        const impactedCallers = buildImpactedCallers({
            db: this.db,
            changedSymbols,
            clampedDepth,
            classifyFn,
            minConfidence: options.minConfidence,
        });
        const riskSummary = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
        for (const caller of impactedCallers) {
            riskSummary[caller.risk]++;
        }
        return { changedFiles, changedSymbols, impactedCallers, riskSummary };
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // get_architecture
    // ═══════════════════════════════════════════════════════════════════════════
    getArchitecture(aspects) {
        const includeAll = aspects.includes('all');
        const resultMap = new Map();
        const computeAspect = (key, fn) => {
            if (includeAll || aspects.includes(key))
                resultMap.set(key, fn());
        };
        computeAspect('languages', () => this.computeLanguages());
        computeAspect('packages', () => this.computePackages());
        computeAspect('entry_points', () => this.computeEntryPoints());
        computeAspect('routes', () => this.computeRoutes());
        computeAspect('hotspots', () => this.computeHotspots());
        computeAspect('file_tree', () => this.computeFileTree());
        computeAspect('layers', () => this.computeLayers());
        computeAspect('adr', () => {
            const adr = this.db.getAdr(this.projectName);
            return adr ? adr.summary : 'No ADR recorded.';
        });
        return { projectName: this.projectName, aspects: Object.fromEntries(resultMap) };
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // get_graph_schema
    // ═══════════════════════════════════════════════════════════════════════════
    getGraphSchema() {
        const nodeLabelCounts = this.db.getNodeLabelCounts(this.projectName);
        const edgeTypeCounts = this.db.getEdgeTypeCounts(this.projectName);
        const relationshipPatterns = this.db.getRelationshipPatterns(this.projectName);
        const functions = this.db.getNodesByLabel(this.projectName, 'Function');
        const classes = this.db.getNodesByLabel(this.projectName, 'Class');
        return {
            nodeLabelCounts: nodeLabelCounts,
            edgeTypeCounts: edgeTypeCounts,
            relationshipPatterns,
            sampleNames: {
                functions: functions.slice(0, 10).map((f) => f.name),
                classes: classes.slice(0, 10).map((c) => c.name),
                qualifiedNames: functions.slice(0, 5).map((f) => f.qualified_name),
            },
        };
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // search_code
    // ═══════════════════════════════════════════════════════════════════════════
    searchCode(options) {
        return searchCodeFiles(this.db, this.projectName, this.projectRoot, options);
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // get_code_snippet
    // ═══════════════════════════════════════════════════════════════════════════
    getCodeSnippet(qualifiedName) {
        const node = this.db.getNode(qualifiedName);
        if (!node || !node.file_path || !node.start_line || !node.end_line)
            return null;
        const absolutePath = path.resolve(this.projectRoot, node.file_path);
        try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from trusted graph node
            const content = fs.readFileSync(absolutePath, 'utf-8');
            const lines = content.split('\n');
            const startLine = Math.max(0, node.start_line - 1);
            const endLine = Math.min(lines.length, node.end_line);
            return lines.slice(startLine, endLine).join('\n');
        }
        catch {
            return null;
        }
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // Private architecture helpers
    // ═══════════════════════════════════════════════════════════════════════════
    computeLanguages() {
        const files = this.db.getNodesByLabel(this.projectName, 'File');
        if (files.length === 0)
            return 'No files indexed.';
        const langCounts = new Map();
        for (const f of files) {
            const lang = f.props.language ?? 'unknown';
            langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
        }
        return Array.from(langCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([lang, count]) => `${lang}: ${count} files`)
            .join('\n');
    }
    computePackages() {
        const packages = this.db.getNodesByLabel(this.projectName, 'Package');
        if (packages.length === 0)
            return 'No packages detected.';
        return packages
            .map((p) => p.name)
            .sort()
            .join('\n');
    }
    computeEntryPoints() {
        const allSymbols = this.db.searchNodes({ project: this.projectName, limit: 1000 });
        const entryPoints = allSymbols.nodes.filter((n) => {
            return n.props.is_entry_point === true;
        });
        if (entryPoints.length === 0)
            return 'No entry points detected.';
        return entryPoints
            .map((ep) => `${ep.label} ${ep.name} (${ep.file_path ?? 'unknown'})`)
            .join('\n');
    }
    computeRoutes() {
        const routes = this.db.getNodesByLabel(this.projectName, 'Route');
        if (routes.length === 0)
            return 'No routes detected.';
        return routes
            .map((r) => {
            const props = r.props;
            const method = props.method ?? '?';
            const routePath = props.path ?? '?';
            const handler = props.handler ?? '(anonymous)';
            return `${method} ${routePath} -> ${handler} (${r.file_path ?? 'unknown'})`;
        })
            .join('\n');
    }
    computeHotspots() {
        const functions = this.db
            .getNodesByLabel(this.projectName, 'Function')
            .concat(this.db.getNodesByLabel(this.projectName, 'Method'));
        if (functions.length === 0)
            return 'No functions or methods indexed.';
        const scored = functions.map((fn) => ({
            fn,
            score: this.db.getNodeDegree(fn.id, undefined, 'both'),
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored
            .slice(0, 20)
            .map(({ fn, score }) => `${fn.name} (degree: ${score}) -- ${fn.file_path ?? 'unknown'}:${fn.start_line ?? '?'}`)
            .join('\n');
    }
    computeFileTree() {
        const folders = this.db.getNodesByLabel(this.projectName, 'Folder');
        if (folders.length === 0)
            return 'No folder structure indexed.';
        const sortedPaths = folders
            .map((f) => f.props.path)
            .filter(Boolean)
            .sort();
        return sortedPaths
            .map((p) => {
            const depth = p.split('/').length - 1;
            const indent = '  '.repeat(depth);
            const name = path.basename(p);
            return `${indent}${name}/`;
        })
            .join('\n');
    }
    computeLayers() {
        const layers = buildLayerMap(this.db, this.projectName);
        const nonEmpty = Object.entries(layers).filter(([, folderNames]) => folderNames.length > 0);
        if (nonEmpty.length === 0)
            return 'No layer patterns detected.';
        return nonEmpty
            .map(([layer, folderNames]) => `## ${layer}\n${folderNames.join(', ')}`)
            .join('\n\n');
    }
}
// ─── Re-export support symbols consumed by other modules ──────────────────────
export { SYMBOL_LABELS };
//# sourceMappingURL=queryEngine.js.map
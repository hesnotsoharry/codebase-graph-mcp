/**
 * queryEngineSupport.ts — Helper functions extracted from queryEngine.ts
 * to keep the main file under the max-lines / max-lines-per-function limits.
 */
import fs from 'fs';
import path from 'path';
import { gitExec } from './gitExec.js';
// ─── Constants ────────────────────────────────────────────────────────────────
export const MAX_BFS_NODES = 200;
export const MAX_DEPTH = 5;
export const CALL_EDGE_TYPES = ['CALLS', 'HTTP_CALLS', 'ASYNC_CALLS'];
export const SYMBOL_LABELS = ['Function', 'Method', 'Class', 'Interface', 'Type', 'Enum'];
// ─── Trace edge helpers ───────────────────────────────────────────────────────
export function collectTraceEdges(pathNodes, traceEdges) {
    for (let i = 0; i < pathNodes.length - 1; i++) {
        // eslint-disable-next-line security/detect-object-injection -- i is a bounded loop index over a trusted array
        traceEdges.push({ source: pathNodes[i], target: pathNodes[i + 1], type: 'CALLS' });
    }
}
// ─── Risk classification ──────────────────────────────────────────────────────
export function classifyRisk(db, node, depth) {
    const props = node.props;
    if (props.is_entry_point && depth <= 1)
        return 'CRITICAL';
    const inboundDegree = db.getNodeDegree(node.id, 'CALLS', 'in') + db.getNodeDegree(node.id, 'ASYNC_CALLS', 'in');
    if (inboundDegree > 10)
        return 'CRITICAL';
    if (inboundDegree > 5 || depth <= 1)
        return 'HIGH';
    if (inboundDegree > 2 || depth <= 2)
        return 'MEDIUM';
    return 'LOW';
}
// ─── Signature extraction ─────────────────────────────────────────────────────
export function getNodeSignature(node) {
    const props = node.props;
    return props.signature ?? null;
}
// ─── traceCallPath helpers ────────────────────────────────────────────────────
export function deduplicateTraceResult(result) {
    const seenNodes = new Set();
    const uniqueNodes = result.nodes.filter((n) => {
        if (seenNodes.has(n.id))
            return false;
        seenNodes.add(n.id);
        return true;
    });
    const seenEdges = new Set();
    const uniqueEdges = result.edges.filter((e) => {
        const key = `${e.source}|${e.target}`;
        if (seenEdges.has(key))
            return false;
        seenEdges.add(key);
        return true;
    });
    return { ...result, nodes: uniqueNodes, edges: uniqueEdges, totalNodes: uniqueNodes.length };
}
export function buildImpactSummary(riskCounts) {
    return `Impact: ${riskCounts.CRITICAL} critical, ${riskCounts.HIGH} high, ${riskCounts.MEDIUM} medium, ${riskCounts.LOW} low`;
}
// ─── detectChanges helpers ────────────────────────────────────────────────────
export function buildChangedSymbols(db, projectName, changedFiles) {
    const changedSymbols = [];
    for (const file of changedFiles) {
        if (file.status === 'deleted')
            continue;
        const fileNodes = db.getNodesByFile(projectName, file.path);
        for (const node of fileNodes) {
            if (SYMBOL_LABELS.includes(node.label)) {
                changedSymbols.push({
                    name: node.name,
                    label: node.label,
                    filePath: file.path,
                    qualifiedName: node.id,
                });
            }
        }
    }
    return changedSymbols;
}
export function buildImpactedCallers({ db, changedSymbols, clampedDepth, classifyFn, minConfidence, }) {
    const impactedCallers = [];
    const seen = new Set();
    const changedIds = new Set(changedSymbols.map((s) => s.qualifiedName));
    for (const symbol of changedSymbols) {
        const bfsResults = db.bfsTraversal({
            startNodeId: symbol.qualifiedName,
            edgeTypes: CALL_EDGE_TYPES,
            direction: 'inbound',
            maxDepth: clampedDepth,
            maxNodes: 100,
            minConfidence,
        });
        for (const result of bfsResults) {
            if (seen.has(result.id))
                continue;
            seen.add(result.id);
            if (changedIds.has(result.id))
                continue;
            const node = db.getNode(result.id);
            if (!node)
                continue;
            impactedCallers.push({
                name: node.name,
                label: node.label,
                filePath: node.file_path,
                qualifiedName: node.id,
                depth: result.depth,
                risk: classifyFn(node, result.depth),
            });
        }
    }
    return impactedCallers;
}
// ─── getGitChangedFiles ────────────────────────────────────────────────────────
function buildGitDiffArgs(options) {
    switch (options.scope) {
        case 'unstaged':
            return ['diff', '--name-status'];
        case 'staged':
            return ['diff', '--cached', '--name-status'];
        case 'all':
            return ['diff', 'HEAD', '--name-status'];
        case 'branch': {
            const base = options.baseBranch ?? 'main';
            return ['diff', `${base}...HEAD`, '--name-status'];
        }
    }
}
function parseFileStatus(statusChar) {
    switch (statusChar) {
        case 'A':
            return 'added';
        case 'D':
            return 'deleted';
        case 'R':
            return 'renamed';
        default:
            return 'modified';
    }
}
export async function getGitChangedFiles(options, projectRoot) {
    const args = buildGitDiffArgs(options);
    try {
        const { stdout } = await gitExec(args, { cwd: projectRoot, maxBuffer: 5 * 1024 * 1024 });
        const output = stdout.trim();
        if (!output)
            return [];
        return output.split('\n').map((line) => {
            const [status, ...pathParts] = line.split('\t');
            const filePath = pathParts.join('\t');
            return { path: filePath, status: parseFileStatus(status.charAt(0)) };
        });
    }
    catch {
        return [];
    }
}
// ─── searchCode helpers ────────────────────────────────────────────────────────
function buildSearchRegex(options) {
    try {
        const flags = options.caseSensitive ? 'g' : 'gi';
        if (options.regex) {
            // eslint-disable-next-line security/detect-non-literal-regexp -- pattern is intentionally user-supplied regex; caller validates via try/catch
            return new RegExp(options.pattern, flags);
        }
        const escaped = options.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // eslint-disable-next-line security/detect-non-literal-regexp -- pattern is escaped literal string, not a raw user regex
        return new RegExp(escaped, flags);
    }
    catch {
        return null;
    }
}
function buildFileFilter(filePattern) {
    if (!filePattern)
        return null;
    try {
        // Two-pass: first protect ** before replacing *, then restore
        const globToRegex = filePattern
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '<<DS>>')
            .replace(/\*/g, '[^/]*')
            .replace(/<<DS>>/g, '.*')
            .replace(/\?/g, '.');
        // eslint-disable-next-line security/detect-non-literal-regexp -- pattern built from glob escaping, not user regex
        return new RegExp(globToRegex);
    }
    catch {
        return null;
    }
}
function searchFileContent(ctx, total) {
    let content;
    try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from trusted graph node
        content = fs.readFileSync(ctx.absolutePath, 'utf-8');
    }
    catch {
        return total;
    }
    let runningTotal = total;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        ctx.regex.lastIndex = 0;
        // eslint-disable-next-line security/detect-object-injection -- i is a bounded loop index
        const match = ctx.regex.exec(lines[i]);
        if (match) {
            runningTotal++;
            if (runningTotal > ctx.offset && ctx.results.length < ctx.maxResults) {
                ctx.results.push({
                    filePath: ctx.filePath,
                    lineNumber: i + 1,
                    // eslint-disable-next-line security/detect-object-injection -- i is a bounded loop index
                    lineContent: lines[i].slice(0, 200),
                    matchStart: match.index,
                    matchEnd: match.index + match[0].length,
                });
            }
        }
    }
    return runningTotal;
}
export function searchCodeFiles(db, projectName, projectRoot, options) {
    const maxResults = options.maxResults ?? 100;
    const offset = options.offset ?? 0;
    const regex = buildSearchRegex(options);
    if (!regex)
        return { results: [], total: 0, hasMore: false };
    const fileFilter = buildFileFilter(options.filePattern);
    if (options.filePattern && !fileFilter)
        return { results: [], total: 0, hasMore: false };
    const files = db.getNodesByLabel(projectName, 'File');
    const results = [];
    let total = 0;
    for (const file of files) {
        const filePath = file.props.path;
        if (!filePath)
            continue;
        if (fileFilter && !fileFilter.test(filePath))
            continue;
        const absolutePath = path.resolve(projectRoot, filePath);
        total = searchFileContent({ filePath, absolutePath, regex, results, offset, maxResults }, total);
    }
    return { results, total, hasMore: total > offset + maxResults };
}
// ─── computeLayers helpers ────────────────────────────────────────────────────
const LAYER_KEYWORDS = [
    ['Presentation', ['component', 'view', 'page', 'renderer', 'ui', 'frontend']],
    ['API/Routes', ['route', 'api', 'controller', 'handler', 'endpoint']],
    ['Business Logic', ['service', 'usecase', 'domain', 'logic', 'core']],
    ['Data Access', ['model', 'repo', 'database', 'store', 'db', 'data']],
    ['Configuration', ['config', 'setting', 'env']],
    ['Infrastructure', ['infra', 'deploy', 'docker', 'ci', 'scripts']],
];
function classifyFolderPath(p) {
    for (const [layer, keywords] of LAYER_KEYWORDS) {
        if (keywords.some((kw) => p.includes(kw)))
            return layer;
    }
    return null;
}
export function buildRiskSummaryFromNodes(nodes) {
    const riskCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const n of nodes) {
        if (n.risk)
            riskCounts[n.risk]++;
    }
    return buildImpactSummary(riskCounts);
}
export function buildLayerMap(db, projectName) {
    const folders = db.getNodesByLabel(projectName, 'Folder');
    const layerMap = new Map([
        ['Presentation', []],
        ['API/Routes', []],
        ['Business Logic', []],
        ['Data Access', []],
        ['Configuration', []],
        ['Infrastructure', []],
    ]);
    for (const folder of folders) {
        const p = (folder.props.path ?? '').toLowerCase();
        const layer = classifyFolderPath(p);
        if (layer)
            layerMap.get(layer)?.push(folder.name);
    }
    return Object.fromEntries(layerMap);
}
//# sourceMappingURL=queryEngineSupport.js.map
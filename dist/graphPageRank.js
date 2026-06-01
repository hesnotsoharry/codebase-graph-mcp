/**
 * graphPageRank.ts — Weighted personalized PageRank over the System 2 graph DB.
 *
 * Wave 19: Phase 4 of the context-injection overhaul. Provides file-level
 * PageRank scores that feed into contextSelector as a `pagerank` reason
 * (weight = normalizedRank × 40).
 *
 * Design decisions:
 * - Isolated self-loops deprioritized: transition weight 0.1 (Aider convention).
 * - Damping factor 0.85, max 50 iterations, epsilon 1e-6 for convergence.
 * - Cache keyed by `${seedHash}:${graphVersion}` with 60 s TTL.
 * - Pure function (no I/O) — deterministic given inputs. Cache is module-level.
 */
import { createHash } from 'crypto';
const CACHE_TTL_MS = 60_000;
// FIFO-bounded at 20 entries — see Wave 20 Decision 3.
const _cache = new Map();
function buildCacheKey(options) {
    const seedStr = options.seeds
        .map((s) => `${s.id}:${s.weight.toFixed(4)}`)
        .sort()
        .join('|');
    return createHash('sha1')
        .update(seedStr)
        .digest('hex')
        .slice(0, 16)
        .concat(':', options.graphVersion ?? 'v0');
}
function checkCache(key) {
    const entry = _cache.get(key);
    if (!entry)
        return null;
    if (Date.now() - entry.cachedAt >= CACHE_TTL_MS) {
        _cache.delete(key);
        return null;
    }
    return entry.scores;
}
function buildAdjacency(nodeIds, edgeRows) {
    const outbound = new Map();
    const inbound = new Map();
    for (const id of nodeIds) {
        outbound.set(id, []);
        inbound.set(id, []);
    }
    for (const edge of edgeRows) {
        if (!outbound.has(edge.source_id) || !inbound.has(edge.target_id))
            continue;
        outbound.get(edge.source_id).push(edge.target_id);
        inbound.get(edge.target_id).push(edge.source_id);
    }
    return { outbound, inbound };
}
function loadGraphSnapshot(db, project) {
    const rows = db.rawQuery('SELECT id, file_path FROM nodes WHERE project = ?', [
        project,
    ]);
    const nodeIds = rows.map((r) => r.id);
    const nodeToFile = new Map(rows.map((r) => [r.id, r.file_path]));
    const edgeRows = db.rawQuery('SELECT source_id, target_id FROM edges WHERE project = ?', [
        project,
    ]);
    const { outbound, inbound } = buildAdjacency(nodeIds, edgeRows);
    return { nodeIds, outbound, inbound, nodeToFile };
}
// ─── Personalization vector ───────────────────────────────────────────────────
function buildPersonalizationVector(nodeIds, seeds) {
    const vector = new Map();
    let totalWeight = 0;
    const nodeIdSet = new Set(nodeIds);
    for (const seed of seeds) {
        if (!nodeIdSet.has(seed.id))
            continue;
        vector.set(seed.id, (vector.get(seed.id) ?? 0) + seed.weight);
        totalWeight += seed.weight;
    }
    if (totalWeight === 0 || vector.size === 0) {
        const uniform = 1 / nodeIds.length;
        for (const id of nodeIds)
            vector.set(id, uniform);
        return vector;
    }
    for (const [id, w] of vector)
        vector.set(id, w / totalWeight);
    return vector;
}
// ─── Core PageRank iteration ──────────────────────────────────────────────────
const ISOLATED_LOOP_WEIGHT = 0.1;
function distributeScores(graph, scores) {
    const next = new Map();
    for (const id of graph.nodeIds)
        next.set(id, 0);
    for (const src of graph.nodeIds) {
        const outN = graph.outbound.get(src) ?? [];
        const srcScore = scores.get(src) ?? 0;
        if (outN.length === 0) {
            next.set(src, (next.get(src) ?? 0) + srcScore * ISOLATED_LOOP_WEIGHT);
            continue;
        }
        const w = (1 - ISOLATED_LOOP_WEIGHT) / outN.length;
        for (const tgt of outN)
            next.set(tgt, (next.get(tgt) ?? 0) + srcScore * w);
    }
    return next;
}
function applyDamping(state, raw) {
    const { scores, graph, personalization, dampingFactor } = state;
    const uniform = 1 / graph.nodeIds.length;
    let l1 = 0;
    for (const id of graph.nodeIds) {
        const teleport = personalization.get(id) ?? uniform;
        const newScore = dampingFactor * (raw.get(id) ?? 0) + (1 - dampingFactor) * teleport;
        raw.set(id, newScore);
        l1 += Math.abs(newScore - (scores.get(id) ?? 0));
    }
    return { next: raw, l1 };
}
function runSingleIteration(state) {
    return applyDamping(state, distributeScores(state.graph, state.scores));
}
function runPageRankIterations(opts) {
    const { graph, personalization, dampingFactor, maxIterations, epsilon } = opts;
    const n = graph.nodeIds.length;
    if (n === 0)
        return { scores: new Map(), iterations: 0 };
    let scores = new Map();
    for (const id of graph.nodeIds)
        scores.set(id, 1 / n);
    let iterations = 0;
    for (let iter = 0; iter < maxIterations; iter++) {
        const { next, l1 } = runSingleIteration({ scores, graph, personalization, dampingFactor });
        scores = next;
        iterations = iter + 1;
        if (l1 < epsilon)
            break;
    }
    return { scores, iterations };
}
// ─── File-level aggregation ───────────────────────────────────────────────────
function aggregateToFiles(scores, nodeToFile) {
    const fileScores = new Map();
    for (const [nodeId, score] of scores) {
        const filePath = nodeToFile.get(nodeId);
        if (!filePath)
            continue;
        if (score > (fileScores.get(filePath) ?? 0))
            fileScores.set(filePath, score);
    }
    return fileScores;
}
// ─── Public API ──────────────────────────────────────────────────────────────
/**
 * Compute personalized PageRank over the System 2 graph for the given project.
 * Returns file-level scores (max per-symbol score per file).
 * Results are cached for 60 s keyed by (seed-set hash, graph-version).
 */
export function computePageRank(db, options) {
    const cacheKey = buildCacheKey(options);
    const cached = checkCache(cacheKey);
    if (cached)
        return { scores: cached, fromCache: true, iterations: 0 };
    const graph = loadGraphSnapshot(db, options.project);
    if (graph.nodeIds.length === 0)
        return { scores: new Map(), fromCache: false, iterations: 0 };
    const personalization = buildPersonalizationVector(graph.nodeIds, options.seeds);
    const { scores: symbolScores, iterations } = runPageRankIterations({
        graph,
        personalization,
        dampingFactor: options.dampingFactor ?? 0.85,
        maxIterations: options.maxIterations ?? 50,
        epsilon: options.epsilon ?? 1e-6,
    });
    const fileScores = aggregateToFiles(symbolScores, graph.nodeToFile);
    if (_cache.size >= 20) {
        const oldestKey = _cache.keys().next().value;
        if (oldestKey !== undefined)
            _cache.delete(oldestKey);
    }
    _cache.set(cacheKey, { scores: fileScores, cachedAt: Date.now() });
    return { scores: fileScores, fromCache: false, iterations };
}
/**
 * Normalize a raw PageRank score map so the maximum value = 1.0.
 */
export function normalizePageRankScores(scores) {
    if (scores.size === 0)
        return new Map();
    let maxScore = 0;
    for (const v of scores.values())
        if (v > maxScore)
            maxScore = v;
    if (maxScore === 0)
        return new Map(scores);
    const normalized = new Map();
    for (const [k, v] of scores)
        normalized.set(k, v / maxScore);
    return normalized;
}
/** Clear the module-level cache. Intended for testing. */
export function clearPageRankCache() {
    _cache.clear();
}
//# sourceMappingURL=graphPageRank.js.map
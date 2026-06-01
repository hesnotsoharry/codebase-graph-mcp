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
import type { GraphDatabase } from './graphDatabase';
export interface PageRankSeedEntry {
    /** Symbol or file identifier that seeds the personalization vector. */
    id: string;
    /** Relative weight of this seed (will be normalized to sum to 1). */
    weight: number;
}
export interface PageRankOptions {
    /** Project name to scope graph queries. */
    project: string;
    /** Personalization seeds — files/symbols and their unnormalized weights. */
    seeds: PageRankSeedEntry[];
    /** Seed weights for categories (pinned, symbol-match, recent-user-edit). Default Q10 rec. */
    seedWeights?: {
        pinned: number;
        symbol: number;
        user_edit: number;
    };
    /** Damping factor d in [0, 1]. Default 0.85. */
    dampingFactor?: number;
    /** Maximum iterations. Default 50. */
    maxIterations?: number;
    /** Convergence threshold (L1 norm). Default 1e-6. */
    epsilon?: number;
    /** Graph version string for cache invalidation. */
    graphVersion?: string;
}
export interface PageRankResult {
    /** Map from file path → normalized PageRank score in [0, 1]. */
    scores: Map<string, number>;
    /** True if the result came from the module cache. */
    fromCache: boolean;
    /** Number of iterations until convergence (or maxIterations). */
    iterations: number;
}
/**
 * Compute personalized PageRank over the System 2 graph for the given project.
 * Returns file-level scores (max per-symbol score per file).
 * Results are cached for 60 s keyed by (seed-set hash, graph-version).
 */
export declare function computePageRank(db: GraphDatabase, options: PageRankOptions): PageRankResult;
/**
 * Normalize a raw PageRank score map so the maximum value = 1.0.
 */
export declare function normalizePageRankScores(scores: Map<string, number>): Map<string, number>;
/** Clear the module-level cache. Intended for testing. */
export declare function clearPageRankCache(): void;
//# sourceMappingURL=graphPageRank.d.ts.map
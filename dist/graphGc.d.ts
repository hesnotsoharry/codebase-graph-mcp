/**
 * graphGc.ts — GC pruner for stale project graphs.
 *
 * Iterates all known projects and removes those whose last_opened_at
 * is strictly older than the configured threshold. Projects with
 * last_opened_at === 0 (never opened under the new schema) are preserved.
 *
 * Also exports purgeSkippedNodes — a one-time migration pass that evicts nodes
 * whose file_path matches skip rules (e.g. .claude/worktrees subtrees). Gated
 * by the graph_metadata key `gc_schema_v2` so it runs at most once per DB.
 *
 * Mutual exclusion: pruneExpiredProjects checks if indexing is in progress
 * and defers to the next cycle if so, allowing the indexing worker and GC
 * to never run concurrently.
 */
import type { Logger } from './loggerInterface';
import type { GraphDatabase } from './graphDatabase';
import type { IndexingWorkerClient } from './indexingWorkerClient';
export interface PurgeSkippedReport {
    alreadyDone: boolean;
    projectsScanned: number;
    totalPurged: number;
}
/**
 * One-time GC: delete all nodes whose file_path falls inside a worktree subtree.
 * Writes `gc_schema_v2 = done` on completion so subsequent calls are no-ops.
 */
export declare function purgeSkippedNodes(db: GraphDatabase, logger?: Logger): PurgeSkippedReport;
export interface PruneReport {
    prunedCount: number;
    keptCount: number;
    prunedProjects: string[];
}
/**
 * Prune expired projects from the graph database.
 *
 * @param db - the graph database
 * @param thresholdDays - projects older than this many days are pruned
 * @param workerClient - optional worker client; if indexing is in progress GC is deferred
 * @param logger - optional logger; defaults to consoleErrorLogger
 */
export declare function pruneExpiredProjects(db: GraphDatabase, thresholdDays: number, workerClient?: IndexingWorkerClient | null, logger?: Logger): PruneReport;
//# sourceMappingURL=graphGc.d.ts.map
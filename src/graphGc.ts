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
import { consoleErrorLogger } from './loggerInterface';
import type { GraphDatabase } from './graphDatabase';
import type { IndexingWorkerClient } from './indexingWorkerClient';

/** Metadata key that marks the skip-node GC pass as done for this DB. */
const GC_SCHEMA_V2_KEY = 'gc_schema_v2';

/** Worktree path substring used by the bulk-delete helper. */
const WORKTREE_SUBSTR = '.claude/worktrees/';

export interface PurgeSkippedReport {
  alreadyDone: boolean;
  projectsScanned: number;
  totalPurged: number;
}

/**
 * One-time GC: delete all nodes whose file_path falls inside a worktree subtree.
 * Writes `gc_schema_v2 = done` on completion so subsequent calls are no-ops.
 */
export function purgeSkippedNodes(
  db: GraphDatabase,
  logger: Logger = consoleErrorLogger,
): PurgeSkippedReport {
  if (db.getGraphMetadata(GC_SCHEMA_V2_KEY) === 'done') {
    return { alreadyDone: true, projectsScanned: 0, totalPurged: 0 };
  }

  const projects = db.listAllProjects();
  let totalPurged = 0;

  db.transaction(() => {
    for (const p of projects) {
      const purged = db.deleteNodesByFilePathSubstring(p.name, WORKTREE_SUBSTR);
      if (purged > 0) {
        logger.info(`[graphGc] purged ${purged} stale worktree nodes from project "${p.name}"`);
        totalPurged += purged;
      }
    }
    db.setGraphMetadata(GC_SCHEMA_V2_KEY, 'done');
  });

  logger.info(
    `[graphGc] skip-node GC complete — ${totalPurged} nodes purged across ${projects.length} projects`,
  );
  return { alreadyDone: false, projectsScanned: projects.length, totalPurged };
}

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
export function pruneExpiredProjects(
  db: GraphDatabase,
  thresholdDays: number,
  workerClient?: IndexingWorkerClient | null,
  logger: Logger = consoleErrorLogger,
): PruneReport {
  // Check if indexing is in progress; defer GC to the next cycle if so.
  // Try-acquire pattern: GC never waits, it just skips this cycle.
  // Worker client may be absent in test contexts; treat absent as "not indexing".
  if (workerClient?.isIndexingInProgress?.()) {
    logger.info('[graphGc] skipping cycle — indexing in progress');
    return { prunedCount: 0, keptCount: 0, prunedProjects: [] };
  }

  const cutoff = Date.now() - thresholdDays * 86_400_000;
  const projects = db.listAllProjects();
  const prunedProjects: string[] = [];
  let keptCount = 0;

  for (const p of projects) {
    if (p.last_opened_at === 0 || p.last_opened_at >= cutoff) {
      keptCount++;
      continue;
    }
    const daysAgo = Math.floor((Date.now() - p.last_opened_at) / 86_400_000);
    const report = db.pruneProject(p.name);
    logger.info(
      `Pruned graph for project ${p.name}, last opened ${daysAgo} days ago` +
        ` (${report.nodes} nodes, ${report.edges} edges)`,
    );
    prunedProjects.push(p.name);
  }

  return { prunedCount: prunedProjects.length, keptCount, prunedProjects };
}

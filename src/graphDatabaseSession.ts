/**
 * graphDatabaseSession.ts — Session-scoped change detection and catalog-hash helpers.
 *
 * Extracted from graphDatabase.ts to keep it under the 300-line ESLint limit.
 * Contains: per-session blast-radius analysis, catalog hash computation, and
 * project prune helpers.
 */

import { xxh3 } from '@node-rs/xxhash';
import type Database from 'better-sqlite3';

import type { ChangedSymbol, ChangedSymbolsForSession } from './detectChangesForSessionTypes';
import type { FileHashRecord, GraphEdge, GraphNode } from './graphDatabaseTypes';

// Minimal interface for the parts of GraphDatabase that session helpers need.
export interface SessionDbAccessor {
  getFileHash(project: string, relPath: string): FileHashRecord | null;
  getNodesByFile(project: string, filePath: string): GraphNode[];
  getNode(id: string): GraphNode | null;
  getInboundEdges(nodeId: string): GraphEdge[];
}

/** Check whether a file's mtime has advanced past the stored hash record. */
export function isFileChanged(db: SessionDbAccessor, project: string, relPath: string): boolean {
  const stored = db.getFileHash(project, relPath);
  if (!stored) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const stat = fs.statSync(relPath);
    return stat.mtimeMs * 1e6 > stored.mtime_ns;
  } catch {
    return true;
  }
}

/** Collect all immediate inbound neighbour IDs for a given node. */
export function collectInboundNeighbours(db: SessionDbAccessor, id: string, next: Set<string>): void {
  for (const e of db.getInboundEdges(id)) next.add(e.source_id);
}

/** BFS caller expansion up to maxHops levels. */
export function expandCallers(
  db: SessionDbAccessor,
  seedIds: Set<string>,
  maxHops: number,
): Map<string, ChangedSymbol> {
  const result = new Map<string, ChangedSymbol>();
  let frontier = seedIds;
  for (let hop = 0; hop <= maxHops; hop++) {
    const next = new Set<string>();
    for (const id of frontier) {
      if (result.has(id)) continue;
      const node = db.getNode(id);
      if (!node) continue;
      result.set(id, {
        id: node.id,
        name: node.name,
        label: node.label,
        filePath: node.file_path,
        startLine: node.start_line,
        hopDepth: hop,
      });
      if (hop < maxHops) collectInboundNeighbours(db, id, next);
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  return result;
}

/** Full session change detection: returns changed files + affected symbol blast radius. */
export function detectChangesForSession(
  db: SessionDbAccessor,
  projectName: string,
  sessionFiles: string[],
): ChangedSymbolsForSession {
  const changedFiles = sessionFiles.filter((f) => isFileChanged(db, projectName, f));
  const directIds = new Set<string>();
  for (const f of changedFiles) {
    for (const n of db.getNodesByFile(projectName, f)) directIds.add(n.id);
  }
  const affected = expandCallers(db, directIds, 2);
  return {
    projectName,
    changedFiles,
    affectedSymbols: Array.from(affected.values()),
    blastRadius: affected.size,
  };
}

// ─── Catalog hash helpers ─────────────────────────────────────────────────────

/** Compute xxh3-128 catalog hash from file hash rows. */
function computeCatalogHash(rows: Array<{ rel_path: string; content_hash: string }>): string {
  const payload = rows.map((r) => `${r.rel_path}\x00${r.content_hash}`).join('\n');
  return xxh3.xxh128(Buffer.from(payload)).toString(16).padStart(32, '0');
}

const CATALOG_HASH_SQL =
  'SELECT rel_path, content_hash FROM file_hashes WHERE project = ? ORDER BY rel_path';

/** Write a catalog hash for the given project to graph_metadata. */
export function writeCatalogHash(db: Database.Database, projectName: string): void {
  const rows = db.prepare(CATALOG_HASH_SQL).all(projectName) as Array<{
    rel_path: string;
    content_hash: string;
  }>;
  const hash = computeCatalogHash(rows);
  db.prepare('INSERT OR REPLACE INTO graph_metadata (key, value) VALUES (?, ?)').run(
    `catalog_hash:${projectName}`,
    hash,
  );
}

/**
 * Invalidate the stored catalog hash for the given project by writing an empty string.
 * `verifyCatalogHash` will return false on next call, triggering a clean rebuild.
 * Use when a pass threw during indexing so a partial index is not accepted as complete.
 */
export function invalidateCatalogHash(db: Database.Database, projectName: string): void {
  db.prepare('INSERT OR REPLACE INTO graph_metadata (key, value) VALUES (?, ?)').run(
    `catalog_hash:${projectName}`,
    '',
  );
}

/** Verify the stored catalog hash matches the current file-hash state. Returns true if valid. */
export function verifyCatalogHash(db: Database.Database, projectName: string): boolean {
  const row = db
    .prepare('SELECT value FROM graph_metadata WHERE key = ?')
    .get(`catalog_hash:${projectName}`) as { value: string } | undefined;
  if (!row) return true;
  const rows = db.prepare(CATALOG_HASH_SQL).all(projectName) as Array<{
    rel_path: string;
    content_hash: string;
  }>;
  return computeCatalogHash(rows) === row.value;
}

/** Delete file_hashes and project rows; return counts of orphaned nodes and edges. */
export function pruneProject(
  db: Database.Database,
  projectName: string,
): { nodes: number; edges: number } {
  const nodes = (
    db.prepare('SELECT COUNT(*) as n FROM nodes WHERE project = ?').get(projectName) as { n: number }
  ).n;
  const edges = (
    db.prepare('SELECT COUNT(*) as n FROM edges WHERE project = ?').get(projectName) as { n: number }
  ).n;
  db.prepare('DELETE FROM file_hashes WHERE project = ?').run(projectName);
  db.prepare('DELETE FROM projects WHERE name = ?').run(projectName);
  return { nodes, edges };
}

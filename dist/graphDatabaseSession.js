/**
 * graphDatabaseSession.ts — Session-scoped change detection and catalog-hash helpers.
 *
 * Extracted from graphDatabase.ts to keep it under the 300-line ESLint limit.
 * Contains: per-session blast-radius analysis, catalog hash computation, and
 * project prune helpers.
 */
import { xxh3 } from '@node-rs/xxhash';
/** Check whether a file's mtime has advanced past the stored hash record. */
export function isFileChanged(db, project, relPath) {
    const stored = db.getFileHash(project, relPath);
    if (!stored)
        return true;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs');
        const stat = fs.statSync(relPath);
        return stat.mtimeMs * 1e6 > stored.mtime_ns;
    }
    catch {
        return true;
    }
}
/** Collect all immediate inbound neighbour IDs for a given node. */
export function collectInboundNeighbours(db, id, next) {
    for (const e of db.getInboundEdges(id))
        next.add(e.source_id);
}
/** BFS caller expansion up to maxHops levels. */
export function expandCallers(db, seedIds, maxHops) {
    const result = new Map();
    let frontier = seedIds;
    for (let hop = 0; hop <= maxHops; hop++) {
        const next = new Set();
        for (const id of frontier) {
            if (result.has(id))
                continue;
            const node = db.getNode(id);
            if (!node)
                continue;
            result.set(id, {
                id: node.id,
                name: node.name,
                label: node.label,
                filePath: node.file_path,
                startLine: node.start_line,
                hopDepth: hop,
            });
            if (hop < maxHops)
                collectInboundNeighbours(db, id, next);
        }
        frontier = next;
        if (frontier.size === 0)
            break;
    }
    return result;
}
/** Full session change detection: returns changed files + affected symbol blast radius. */
export function detectChangesForSession(db, projectName, sessionFiles) {
    const changedFiles = sessionFiles.filter((f) => isFileChanged(db, projectName, f));
    const directIds = new Set();
    for (const f of changedFiles) {
        for (const n of db.getNodesByFile(projectName, f))
            directIds.add(n.id);
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
function computeCatalogHash(rows) {
    const payload = rows.map((r) => `${r.rel_path}\x00${r.content_hash}`).join('\n');
    return xxh3.xxh128(Buffer.from(payload)).toString(16).padStart(32, '0');
}
const CATALOG_HASH_SQL = 'SELECT rel_path, content_hash FROM file_hashes WHERE project = ? ORDER BY rel_path';
/** Write a catalog hash for the given project to graph_metadata. */
export function writeCatalogHash(db, projectName) {
    const rows = db.prepare(CATALOG_HASH_SQL).all(projectName);
    const hash = computeCatalogHash(rows);
    db.prepare('INSERT OR REPLACE INTO graph_metadata (key, value) VALUES (?, ?)').run(`catalog_hash:${projectName}`, hash);
}
/**
 * Invalidate the stored catalog hash for the given project by writing an empty string.
 * `verifyCatalogHash` will return false on next call, triggering a clean rebuild.
 * Use when a pass threw during indexing so a partial index is not accepted as complete.
 */
export function invalidateCatalogHash(db, projectName) {
    db.prepare('INSERT OR REPLACE INTO graph_metadata (key, value) VALUES (?, ?)').run(`catalog_hash:${projectName}`, '');
}
/** Verify the stored catalog hash matches the current file-hash state. Returns true if valid. */
export function verifyCatalogHash(db, projectName) {
    const row = db
        .prepare('SELECT value FROM graph_metadata WHERE key = ?')
        .get(`catalog_hash:${projectName}`);
    if (!row)
        return true;
    const rows = db.prepare(CATALOG_HASH_SQL).all(projectName);
    return computeCatalogHash(rows) === row.value;
}
/** Delete file_hashes and project rows; return counts of orphaned nodes and edges. */
export function pruneProject(db, projectName) {
    const nodes = db.prepare('SELECT COUNT(*) as n FROM nodes WHERE project = ?').get(projectName).n;
    const edges = db.prepare('SELECT COUNT(*) as n FROM edges WHERE project = ?').get(projectName).n;
    db.prepare('DELETE FROM file_hashes WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM projects WHERE name = ?').run(projectName);
    return { nodes, edges };
}
//# sourceMappingURL=graphDatabaseSession.js.map
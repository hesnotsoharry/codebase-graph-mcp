/**
 * graphDatabaseMigrations.ts — Schema migration functions for the codebase graph DB.
 *
 * Each function is idempotent: it checks whether the column/table already exists
 * before issuing the DDL. The caller (graphDatabase.ts) wraps all migrations in
 * a single transaction and sets user_version only after all succeed.
 *
 * Migration history:
 *   v0 → v1: added last_opened_at to projects; added graph_metadata table
 *   v1 → v2: added confidence REAL NOT NULL DEFAULT 1.0 to edges
 */

import type Database from 'better-sqlite3';

export function migrateToV1(db: Database.Database): void {
  const cols = db.pragma('table_info(projects)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'last_opened_at')) {
    db.exec('ALTER TABLE projects ADD COLUMN last_opened_at INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS graph_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  );
}

export function migrateToV2(db: Database.Database): void {
  const cols = db.pragma('table_info(edges)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'confidence')) {
    db.exec('ALTER TABLE edges ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0');
  }
}

/**
 * graphDatabaseMigrations.test.ts — Unit tests for schema migration helpers.
 *
 * Each test constructs a raw better-sqlite3 in-memory DB, applies DDL at a
 * specific version baseline, then calls the migration function directly and
 * asserts the resulting schema.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateToV1, migrateToV2 } from './graphDatabaseMigrations';

// ─── Minimal DDL helpers ──────────────────────────────────────────────────────

/** Create only the tables that existed at schema version 0 (no last_opened_at, no graph_metadata). */
function applyV0Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      name        TEXT PRIMARY KEY,
      root_path   TEXT NOT NULL,
      indexed_at  INTEGER NOT NULL DEFAULT 0,
      node_count  INTEGER NOT NULL DEFAULT 0,
      edge_count  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id             TEXT PRIMARY KEY,
      project        TEXT NOT NULL,
      label          TEXT NOT NULL,
      name           TEXT NOT NULL,
      qualified_name TEXT NOT NULL UNIQUE,
      file_path      TEXT,
      start_line     INTEGER,
      end_line       INTEGER,
      props          TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS edges (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      project   TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type      TEXT NOT NULL,
      props     TEXT NOT NULL DEFAULT '{}',
      UNIQUE(source_id, target_id, type)
    );
  `);
}

/** Create the tables as they stood at schema version 1 (has last_opened_at, graph_metadata, but no confidence). */
function applyV1Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      name           TEXT PRIMARY KEY,
      root_path      TEXT NOT NULL,
      indexed_at     INTEGER NOT NULL DEFAULT 0,
      node_count     INTEGER NOT NULL DEFAULT 0,
      edge_count     INTEGER NOT NULL DEFAULT 0,
      last_opened_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id             TEXT PRIMARY KEY,
      project        TEXT NOT NULL,
      label          TEXT NOT NULL,
      name           TEXT NOT NULL,
      qualified_name TEXT NOT NULL UNIQUE,
      file_path      TEXT,
      start_line     INTEGER,
      end_line       INTEGER,
      props          TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS edges (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      project   TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type      TEXT NOT NULL,
      props     TEXT NOT NULL DEFAULT '{}',
      UNIQUE(source_id, target_id, type)
    );
    CREATE TABLE IF NOT EXISTS graph_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `);
  db.pragma('user_version = 1');
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((r) => r.name);
}

function tableExists(db: Database.Database, name: string): boolean {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .all(name) as Array<{ name: string }>;
  return rows.length > 0;
}

// ─── migrateToV1 ──────────────────────────────────────────────────────────────

describe('migrateToV1', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyV0Schema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('adds last_opened_at column to projects', () => {
    migrateToV1(db);
    expect(columnNames(db, 'projects')).toContain('last_opened_at');
  });

  it('creates graph_metadata table', () => {
    migrateToV1(db);
    expect(tableExists(db, 'graph_metadata')).toBe(true);
  });

  it('is idempotent when last_opened_at already exists', () => {
    migrateToV1(db);
    expect(() => migrateToV1(db)).not.toThrow();
    expect(columnNames(db, 'projects')).toContain('last_opened_at');
  });
});

// ─── migrateToV2 ──────────────────────────────────────────────────────────────

describe('migrateToV2', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyV1Schema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('adds confidence column to edges', () => {
    migrateToV2(db);
    expect(columnNames(db, 'edges')).toContain('confidence');
  });

  it('backfills existing edges with confidence 1.0', () => {
    db.exec(`
      INSERT INTO projects (name, root_path) VALUES ('p', '/r');
      INSERT INTO nodes (id, project, label, name, qualified_name) VALUES ('a', 'p', 'Function', 'a', 'a');
      INSERT INTO nodes (id, project, label, name, qualified_name) VALUES ('b', 'p', 'Function', 'b', 'b');
      INSERT INTO edges (project, source_id, target_id, type) VALUES ('p', 'a', 'b', 'CALLS');
    `);
    migrateToV2(db);
    const rows = db.prepare('SELECT confidence FROM edges').all() as Array<{ confidence: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBe(1.0);
  });

  it('is idempotent when confidence column already exists', () => {
    migrateToV2(db);
    expect(() => migrateToV2(db)).not.toThrow();
    expect(columnNames(db, 'edges')).toContain('confidence');
  });

  it('new edges default to confidence 1.0 after migration', () => {
    migrateToV2(db);
    db.exec(`
      INSERT INTO projects (name, root_path) VALUES ('p2', '/r2');
      INSERT INTO nodes (id, project, label, name, qualified_name) VALUES ('x', 'p2', 'Function', 'x', 'x');
      INSERT INTO nodes (id, project, label, name, qualified_name) VALUES ('y', 'p2', 'Function', 'y', 'y');
      INSERT INTO edges (project, source_id, target_id, type) VALUES ('p2', 'x', 'y', 'CALLS');
    `);
    const rows = db.prepare('SELECT confidence FROM edges WHERE project = ?').all('p2') as Array<{
      confidence: number;
    }>;
    expect(rows[0].confidence).toBe(1.0);
  });
});

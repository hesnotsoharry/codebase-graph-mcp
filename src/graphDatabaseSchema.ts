/**
 * graphDatabaseSchema.ts — SQL DDL for the codebase property graph database.
 *
 * Extracted from graphDatabaseHelpers.ts to stay under the 300-line limit.
 * Import SCHEMA_SQL from here; do not duplicate it elsewhere.
 *
 * Schema versions:
 *   0 → initial (no user_version set)
 *   1 → added last_opened_at to projects; added graph_metadata table
 *   2 → added confidence REAL NOT NULL DEFAULT 1.0 to edges
 */

// ─── Node label constants (informational — actual values are in graphDatabaseTypes.ts) ──
// Labels: Project, Package, Folder, File, Module, Function, Method, Class,
//         Interface, Type, Enum, Route, Variable, Export

// ─── Edge type constants (informational — actual values are in graphDatabaseTypes.ts) ───
// Types: CONTAINS_PACKAGE, CONTAINS_FOLDER, CONTAINS_FILE, DEFINES, DEFINES_METHOD,
//        IMPORTS, CALLS, HTTP_CALLS, ASYNC_CALLS, IMPLEMENTS, HANDLES, USAGE,
//        CONFIGURES, WRITES, MEMBER_OF, TESTS, USES_TYPE, FILE_CHANGES_WITH,
//        EXPORTS, EXTENDS

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  name            TEXT PRIMARY KEY,
  root_path       TEXT NOT NULL,
  indexed_at      INTEGER NOT NULL DEFAULT 0,
  node_count      INTEGER NOT NULL DEFAULT 0,
  edge_count      INTEGER NOT NULL DEFAULT 0,
  last_opened_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nodes (
  id             TEXT PRIMARY KEY,
  project        TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  name           TEXT NOT NULL,
  qualified_name TEXT NOT NULL UNIQUE,
  file_path      TEXT,
  start_line     INTEGER,
  end_line       INTEGER,
  props          TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project);
CREATE INDEX IF NOT EXISTS idx_nodes_label   ON nodes(label);
CREATE INDEX IF NOT EXISTS idx_nodes_name    ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_file    ON nodes(file_path);

CREATE TABLE IF NOT EXISTS edges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project    TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  props      TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 1.0,
  UNIQUE(source_id, target_id, type)
);

CREATE INDEX IF NOT EXISTS idx_edges_source  ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target  ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type    ON edges(type);
CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project);

CREATE TABLE IF NOT EXISTS file_hashes (
  project      TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mtime_ns     INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  PRIMARY KEY (project, rel_path)
);

CREATE TABLE IF NOT EXISTS project_summaries (
  project     TEXT PRIMARY KEY REFERENCES projects(name) ON DELETE CASCADE,
  summary     TEXT NOT NULL DEFAULT '{}',
  source_hash TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS graph_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, qualified_name, file_path,
  content='nodes', content_rowid='rowid', tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, qualified_name, file_path)
  VALUES (new.rowid, new.name, new.qualified_name, new.file_path);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, file_path)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.file_path);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, file_path)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.file_path);
  INSERT INTO nodes_fts(rowid, name, qualified_name, file_path)
  VALUES (new.rowid, new.name, new.qualified_name, new.file_path);
END;
`;

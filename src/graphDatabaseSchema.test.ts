/**
 * graphDatabaseSchema.test.ts — Smoke tests for SCHEMA_SQL and SCHEMA_VERSION.
 *
 * Verifies that the exported SQL string is well-formed and that the schema
 * version constant is correct. Migration correctness is tested in
 * graphDatabase.test.ts (requires a live better-sqlite3 instance).
 */

import { describe, expect, it } from 'vitest';

import { SCHEMA_SQL, SCHEMA_VERSION } from './graphDatabaseSchema';

describe('graphDatabaseSchema', () => {
  describe('SCHEMA_VERSION', () => {
    it('is a positive integer', () => {
      expect(typeof SCHEMA_VERSION).toBe('number');
      expect(SCHEMA_VERSION).toBeGreaterThan(0);
    });

    it('equals 2 (Wave 66 — confidence column on edges)', () => {
      expect(SCHEMA_VERSION).toBe(2);
    });
  });

  describe('SCHEMA_SQL', () => {
    it('is a non-empty string', () => {
      expect(typeof SCHEMA_SQL).toBe('string');
      expect(SCHEMA_SQL.length).toBeGreaterThan(0);
    });

    it('creates the projects table with last_opened_at', () => {
      expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS projects');
      expect(SCHEMA_SQL).toContain('last_opened_at');
    });

    it('creates the graph_metadata table', () => {
      expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS graph_metadata');
      expect(SCHEMA_SQL).toContain('key   TEXT PRIMARY KEY');
    });

    it('creates nodes, edges, file_hashes, project_summaries tables', () => {
      expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS nodes');
      expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS edges');
      expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS file_hashes');
      expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS project_summaries');
    });

    it('creates FTS5 virtual table with trigram tokenizer', () => {
      expect(SCHEMA_SQL).toContain('USING fts5');
      expect(SCHEMA_SQL).toContain("tokenize='trigram'");
    });

    it('creates all required indexes', () => {
      expect(SCHEMA_SQL).toContain('idx_nodes_project');
      expect(SCHEMA_SQL).toContain('idx_edges_source');
      expect(SCHEMA_SQL).toContain('idx_edges_target');
    });

    it('creates FTS sync triggers', () => {
      expect(SCHEMA_SQL).toContain('AFTER INSERT ON nodes');
      expect(SCHEMA_SQL).toContain('AFTER DELETE ON nodes');
      expect(SCHEMA_SQL).toContain('AFTER UPDATE ON nodes');
    });

    it('graph_metadata table uses STRICT mode', () => {
      expect(SCHEMA_SQL).toContain(') STRICT;');
    });
  });
});

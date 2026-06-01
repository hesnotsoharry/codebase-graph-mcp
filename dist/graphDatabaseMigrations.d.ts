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
export declare function migrateToV1(db: Database.Database): void;
export declare function migrateToV2(db: Database.Database): void;
//# sourceMappingURL=graphDatabaseMigrations.d.ts.map
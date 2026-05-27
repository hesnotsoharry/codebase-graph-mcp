/**
 * serverBootstrap.storageMigration.test.ts — Unit tests for the
 * migrateOuroborosPath helper embedded in buildDbPath().
 *
 * Covers:
 *   1. OLD-ONLY scenario: old dir + DB → moved to new dir; old dir absent after.
 *   2. BOTH-EXIST scenario: non-destructive; both dirs remain; warning on stderr.
 *   3. Rename-failure scenario: EPERM on whole-tree rename does not crash server;
 *      buildDbPath returns the new path and logs a warning.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDbPath } from './serverBootstrap';

/**
 * Each test runs with a temporary directory substituting as HOME, so
 * os.homedir() is patched to return that dir for the duration of the test.
 */
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-migrate-test-'));
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(() => {
  homedirSpy.mockRestore();
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

/** Deterministic hash matching what buildDbPath computes for a given rootPath. */
function hashFor(rootPath: string): string {
  return crypto.createHash('sha256').update(rootPath).digest('hex').slice(0, 8);
}

describe('buildDbPath() storage migration helper', () => {
  describe('OLD-ONLY scenario: moves ~/.ouroboros-graph to ~/.codebase-graph when new path absent', () => {
    it('migrated hash dir has graph.db and old root no longer holds the data', () => {
      const projectRoot = path.join(os.tmpdir(), 'test-project-migrate-a');
      const hash = hashFor(projectRoot);

      // Pre-condition: old dir with a graph.db, no new dir yet
      const oldHashDir = path.join(fakeHome, '.ouroboros-graph', hash);
      fs.mkdirSync(oldHashDir, { recursive: true });
      fs.writeFileSync(path.join(oldHashDir, 'graph.db'), 'fake-db-old');

      const returnedPath = buildDbPath(projectRoot);

      // Returned path must be under the new root
      expect(returnedPath).toContain('.codebase-graph');
      expect(returnedPath).not.toContain('.ouroboros-graph');

      // New hash dir must have the graph.db (migrated)
      const newHashDir = path.join(fakeHome, '.codebase-graph', hash);
      expect(fs.existsSync(path.join(newHashDir, 'graph.db'))).toBe(true);

      // Old hash dir should not exist any more (moved atomically)
      expect(fs.existsSync(oldHashDir)).toBe(false);
    });
  });

  describe('BOTH-EXIST scenario: leaves both dirs untouched + warns on stderr when both paths present', () => {
    it('both roots remain and stderr contains collision warning with old path reference', () => {
      const projectRoot = path.join(os.tmpdir(), 'test-project-migrate-c');
      const hash = hashFor(projectRoot);

      // Pre-condition: colliding hash dir in BOTH old and new roots
      const oldHashDir = path.join(fakeHome, '.ouroboros-graph', hash);
      const newHashDir = path.join(fakeHome, '.codebase-graph', hash);
      fs.mkdirSync(oldHashDir, { recursive: true });
      fs.mkdirSync(newHashDir, { recursive: true });
      fs.writeFileSync(path.join(oldHashDir, 'graph.db'), 'fake-db-old-c');
      fs.writeFileSync(path.join(newHashDir, 'graph.db'), 'fake-db-new-c');

      const stderrLines: string[] = [];
      const origConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        stderrLines.push(args.map(String).join(' '));
      };

      let returnedPath: string;
      try {
        returnedPath = buildDbPath(projectRoot);
      } finally {
        console.error = origConsoleError;
      }

      // Returned path must be under the new root
      expect(returnedPath!).toContain('.codebase-graph');
      expect(returnedPath!).not.toContain('.ouroboros-graph');

      // Both roots must still exist (non-destructive)
      expect(fs.existsSync(path.join(fakeHome, '.ouroboros-graph'))).toBe(true);
      expect(fs.existsSync(path.join(fakeHome, '.codebase-graph'))).toBe(true);

      // Old DB must be untouched
      expect(fs.readFileSync(path.join(oldHashDir, 'graph.db'), 'utf8')).toBe('fake-db-old-c');

      // stderr must contain a warning mentioning the old path ('ouroboros' OR 'manually')
      const combinedStderr = stderrLines.join('\n').toLowerCase();
      const hasWarning =
        combinedStderr.includes('ouroboros') ||
        combinedStderr.includes('manually');
      expect(hasWarning).toBe(true);
    });
  });

  describe('Rename-failure scenario: EPERM on whole-tree rename does not crash server', () => {
    it('buildDbPath returns new path and logs a warning when fs.renameSync throws EPERM', () => {
      const projectRoot = path.join(os.tmpdir(), 'test-project-migrate-eperm');
      const hash = hashFor(projectRoot);

      // Pre-condition: old dir exists with a hash subdir and graph.db; new dir absent.
      // This triggers the OLD-ONLY fast path which will fail with our injected EPERM.
      const oldHashDir = path.join(fakeHome, '.ouroboros-graph', hash);
      fs.mkdirSync(oldHashDir, { recursive: true });
      fs.writeFileSync(path.join(oldHashDir, 'graph.db'), 'fake-db-eperm');

      // Inject EPERM on every renameSync call (simulates a locked file inside the tree).
      const epermError = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw epermError;
      });

      const stderrLines: string[] = [];
      const origConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        stderrLines.push(args.map(String).join(' '));
      };

      let returnedPath: string;
      let threw = false;
      try {
        returnedPath = buildDbPath(projectRoot);
      } catch {
        threw = true;
        returnedPath = '';
      } finally {
        console.error = origConsoleError;
        renameSpy.mockRestore();
      }

      // buildDbPath MUST NOT throw — server must start
      expect(threw).toBe(false);

      // Returned path must point to the new root (migration failure falls through gracefully)
      expect(returnedPath).toContain('.codebase-graph');
      expect(returnedPath).not.toContain('.ouroboros-graph');

      // stderr must contain a warning about the failure (either the whole-tree fallback message
      // or the per-subdir failure message or the top-level abort message)
      const combinedStderr = stderrLines.join('\n').toLowerCase();
      const hasWarning =
        combinedStderr.includes('eperm') ||
        combinedStderr.includes('rename failed') ||
        combinedStderr.includes('could not be migrated') ||
        combinedStderr.includes('migration aborted');
      expect(hasWarning).toBe(true);
    });
  });
});

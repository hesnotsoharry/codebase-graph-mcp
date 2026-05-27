/**
 * graphControllerSupport.test.ts — Unit tests for the per-root controller
 * registry and GraphControllerLike singleton helpers.
 *
 * These tests use a lightweight stub that satisfies GraphControllerLike so
 * no real DB or tree-sitter runtime is needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphControllerLike } from './graphControllerSupport';
import {
  getGraphController,
  getGraphControllerForRoot,
  releaseGraphController,
  setGraphController,
  setSystem2Db,
} from './graphControllerSupport';

// ── Stub factory ─────────────────────────────────────────────────────────────

function makeStub(rootPath: string): GraphControllerLike & { disposed: boolean } {
  return {
    rootPath,
    disposed: false,
    getStatus: () => ({
      initialized: true,
      projectRoot: rootPath,
      projectName: 'test',
      nodeCount: 0,
      edgeCount: 0,
      fileCount: 0,
      lastIndexedAt: 0,
      indexDurationMs: 0,
    }),
    indexStatus: function () {
      return this.getStatus();
    },
    getGraphToolContext: () => ({
      db: {} as never,
      queryEngine: {} as never,
      cypherEngine: {} as never,
      pipeline: {
        index: async () => ({
          success: true,
          projectName: 'test',
          filesIndexed: 0,
          filesSkipped: 0,
          nodesCreated: 0,
          edgesCreated: 0,
          durationMs: 0,
          incremental: false,
          errors: [],
        }),
      },
      projectRoot: rootPath,
      projectName: 'test',
    }),
    onSessionStart: vi.fn(),
    onGitCommit: vi.fn(),
    onFileChange: vi.fn(),
    indexRepository: async () => ({ success: true }),
    listProjects: () => [rootPath],
    deleteProject: () => ({ success: true }),
    detectChanges: async () => ({ changedFiles: [], affectedSymbols: [], blastRadius: 0 }),
    detectChangesForSession: async () => ({
      changedFiles: [],
      affectedSymbols: [],
      blastRadius: 0,
    }),
    getArchitecture: () => ({
      projectName: 'test',
      modules: [],
      hotspots: [],
      fileTree: [],
    }),
    getCodeSnippet: async () => null,
    getGraphSchema: () => ({ nodeTypes: [], edgeTypes: [], nodeCount: 0, edgeCount: 0 }),
    ingestTraces: () => ({ success: true, ingested: 0 }),
    manageAdr: () => ({ success: true }),
    queryGraph: () => [],
    searchCode: async () => [],
    searchGraph: () => [],
    traceCallPath: () => ({ found: false, path: [], edges: [] }),
    dispose: async function () {
      this.disposed = true;
    },
  };
}

// ── Helpers to clear module-level registry state between tests ───────────────
//
// graphControllerSupport holds module-level registry Map + defaultRoot.
// We reset state by releasing any roots we registered during the test.

const registeredRoots: string[] = [];

function trackSet(stub: GraphControllerLike): void {
  setGraphController(stub);
  registeredRoots.push(stub.rootPath);
}

afterEach(async () => {
  // Release all roots registered during the test to reset internal state.
  for (const root of registeredRoots) {
    await releaseGraphController(root).catch(() => {
      /* already gone */
    });
  }
  registeredRoots.length = 0;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('setSystem2Db', () => {
  it('accepts any value without throwing', () => {
    expect(() => setSystem2Db({ mock: 'db' })).not.toThrow();
    expect(() => setSystem2Db(null)).not.toThrow();
  });
});

describe('setGraphController / getGraphController', () => {
  it('returns null when nothing is registered', () => {
    // Fresh test — nothing registered yet
    expect(getGraphController()).toBeNull();
  });

  it('returns the registered controller', () => {
    const stub = makeStub('/tmp/project-a');
    trackSet(stub);
    expect(getGraphController()).toBe(stub);
  });

  it('overrides the default root when a second controller is set', () => {
    const a = makeStub('/tmp/project-a');
    const b = makeStub('/tmp/project-b');
    trackSet(a);
    trackSet(b);
    // Most recent set wins as default
    expect(getGraphController()).toBe(b);
  });
});

describe('getGraphControllerForRoot', () => {
  beforeEach(() => {
    const stub = makeStub('/tmp/project-x');
    trackSet(stub);
  });

  it('returns the controller for the exact root', () => {
    const ctrl = getGraphControllerForRoot('/tmp/project-x');
    expect(ctrl).not.toBeNull();
    expect(ctrl?.rootPath).toBe('/tmp/project-x');
  });

  it('returns null for an unregistered root', () => {
    expect(getGraphControllerForRoot('/tmp/not-registered')).toBeNull();
  });

  it('normalizes trailing slashes', () => {
    const ctrl = getGraphControllerForRoot('/tmp/project-x/');
    expect(ctrl).not.toBeNull();
  });
});

describe('releaseGraphController', () => {
  it('is a no-op for an unregistered root', async () => {
    await expect(releaseGraphController('/tmp/nonexistent')).resolves.toBeUndefined();
  });

  it('calls dispose() when ref-count reaches zero', async () => {
    const stub = makeStub('/tmp/project-dispose');
    trackSet(stub);

    // setGraphController sets refCount to 1, so one release disposes
    await releaseGraphController('/tmp/project-dispose');
    registeredRoots.pop(); // already released — remove from cleanup list

    expect(stub.disposed).toBe(true);
    expect(getGraphControllerForRoot('/tmp/project-dispose')).toBeNull();
  });
});

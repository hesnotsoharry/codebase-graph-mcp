/**
 * graphControllerCompat.contract.test.ts
 *
 * Contract test for GraphControllerCompat.getGraphToolContext().
 * Asserts that the returned object satisfies the full GraphToolContext shape —
 * all six fields present and typed. Catches future regressions where someone
 * narrows the type or omits fields in the implementation.
 */

import { describe, expect, it, vi } from 'vitest';

import type { CypherEngine } from './cypherEngine';
import { type CompatHandle, GraphControllerCompat } from './graphControllerCompat';
import type { GraphDatabase } from './graphDatabase';
import type { GraphToolContext } from './graphTypes';
import type { QueryEngine } from './queryEngine';

// ── Minimal stubs ──────────────────────────────────────────────────────────────

function makeHandle(): CompatHandle {
  const mockDb = {
    getProject: () => null,
  } as unknown as GraphDatabase;

  const mockQueryEngine = {} as unknown as QueryEngine;
  const mockCypherEngine = {} as unknown as CypherEngine;

  const mockWorkerClient = {
    runIndex: vi.fn().mockResolvedValue({
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
  };

  return {
    db: mockDb,
    queryEngine: mockQueryEngine,
    cypherEngine: mockCypherEngine,
    workerClient: mockWorkerClient as never,
    watcher: null,
    projectRoot: '/test/root',
    projectName: 'test-project',
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GraphControllerCompat.getGraphToolContext() — contract', () => {
  it('returns an object satisfying GraphToolContext (all six fields present)', () => {
    const handle = makeHandle();
    const compat = new GraphControllerCompat(handle);
    const ctx: GraphToolContext = compat.getGraphToolContext();

    expect(ctx.db).toBe(handle.db);
    expect(ctx.queryEngine).toBe(handle.queryEngine);
    expect(ctx.cypherEngine).toBe(handle.cypherEngine);
    expect(ctx.projectRoot).toBe('/test/root');
    expect(ctx.projectName).toBe('test-project');
    expect(typeof ctx.pipeline.index).toBe('function');
  });

  it('pipeline.index delegates to workerClient.runIndex', async () => {
    const handle = makeHandle();
    const compat = new GraphControllerCompat(handle);
    const { pipeline } = compat.getGraphToolContext();

    await pipeline.index({ projectRoot: '/test/root', incremental: true });

    expect(handle.workerClient.runIndex).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: '/test/root', incremental: true }),
    );
  });
});

/**
 * indexingPipeline.noopt.test.ts — Unit test for IndexingPipeline no-op fast-path.
 *
 * Tests the runIndex no-op scenario (incremental=true, 0 changed files).
 * Mocks the lower-level dependencies to verify the fast-path returns
 * the expected buildNoOpResult shape without running parsing or passes.
 */

import { describe, expect, it, vi } from 'vitest';

import { IndexingPipeline } from './indexingPipeline';
import type { DiscoveredFile, IndexingOptions } from './indexingPipelineTypes';

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./indexingPipelineIncremental', () => ({
  discoverFiles: vi.fn(),
  filterChangedFiles: vi.fn(),
  filterChangedFilesSubset: vi.fn(),
  resolveIncrementalFiles: vi.fn(),
}));

vi.mock('./indexingPipelinePasses', () => ({
  structurePass: vi.fn(),
  definitionPass: vi.fn(),
  importPass: vi.fn(),
  parsePass: vi.fn(),
}));

vi.mock('./indexingPipelineCallResolution', () => ({
  callResolutionPass: vi.fn(),
}));

vi.mock('./passes/enrichmentPass', () => ({
  enrichmentPass: vi.fn(),
}));

vi.mock('./passes/gitCoChangePass', () => ({
  gitCoChangePass: vi.fn(),
  prefetchGitCoChangeData: vi.fn(),
}));

vi.mock('./passes/httpLinkPass', () => ({
  httpLinkPass: vi.fn(),
}));

vi.mock('./passes/testDetectPass', () => ({
  testDetectPass: vi.fn(),
}));

describe('IndexingPipeline — no-op fast-path (cache-preservation regression)', () => {
  it('preserves existing node_count/edge_count in the cache after a no-op incremental run', async () => {
    // Regression guard for the bug where discoverAndResolve zeroed node_count/edge_count
    // before every index run. A no-op fast-path (0 changed files) would then exit without
    // calling finalizeIndex, leaving the cache permanently stuck at 0.
    //
    // Fix: discoverAndResolve reads the existing project row and preserves its counts.
    // This test verifies that upsertProject is NOT called with 0/0 when a prior non-zero
    // count exists, and that the second upsertProject call (in discoverAndResolve) carries
    // the preserved values.
    const { resolveIncrementalFiles, discoverFiles } = await import('./indexingPipelineIncremental');

    const EXISTING_NODE_COUNT = 42;
    const EXISTING_EDGE_COUNT = 17;

    const existingProject = {
      name: 'test-proj',
      root_path: '/proj',
      indexed_at: Date.now() - 1000,
      node_count: EXISTING_NODE_COUNT,
      edge_count: EXISTING_EDGE_COUNT,
    };

    const upsertCalls: Array<{ node_count: number; edge_count: number }> = [];

    const mockDb = {
      // Returns the pre-existing project with non-zero counts
      getProject: vi.fn().mockReturnValue(existingProject),
      upsertProject: vi.fn((args) => {
        upsertCalls.push({ node_count: args.node_count, edge_count: args.edge_count });
      }),
      deleteProject: vi.fn(),
      getFileHash: vi.fn(),
      upsertFileHash: vi.fn(),
      deleteFileHash: vi.fn(),
      getAllFileHashes: vi.fn().mockReturnValue([]),
      deleteNodesByFile: vi.fn(),
      transaction: vi.fn((fn) => fn()),
      getNodeCount: vi.fn().mockReturnValue(EXISTING_NODE_COUNT),
      getEdgeCount: vi.fn().mockReturnValue(EXISTING_EDGE_COUNT),
      setGraphMetadata: vi.fn(),
    };

    const mockParser = {};

    const allFiles: DiscoveredFile[] = [
      {
        absolutePath: '/proj/src/a.ts',
        relativePath: 'src/a.ts',
        extension: 'ts',
        sizeBytes: 100,
        mtimeMs: 1_000_000,
      },
    ];

    vi.mocked(discoverFiles).mockResolvedValue(allFiles);
    vi.mocked(resolveIncrementalFiles).mockResolvedValue({
      filesToProcess: [], // No files changed — triggers the no-op fast-path
      isIncrementalRun: true,
    });

    const pipeline = new IndexingPipeline(mockDb as never, mockParser as never);

    const options: IndexingOptions = {
      projectRoot: '/proj',
      projectName: 'test-proj',
      incremental: true,
    };

    await pipeline.index(options);

    // The marker upsert in discoverAndResolve must have been called (once — the no-op
    // path does NOT call finalizeIndex, so there's exactly 1 upsertProject call).
    expect(upsertCalls).toHaveLength(1);

    // That single call must carry the preserved counts, NOT zeros.
    expect(upsertCalls[0].node_count).toBe(EXISTING_NODE_COUNT);
    expect(upsertCalls[0].edge_count).toBe(EXISTING_EDGE_COUNT);
  });
});

describe('IndexingPipeline — no-op fast-path', () => {
  it('returns buildNoOpResult when filesToProcess is empty and isIncrementalRun is true', async () => {
    const { resolveIncrementalFiles } = await import('./indexingPipelineIncremental');
    const { discoverFiles } = await import('./indexingPipelineIncremental');

    const mockDb = {
      getProject: vi.fn().mockReturnValue({ name: 'test-proj' }),
      upsertProject: vi.fn(),
      deleteProject: vi.fn(),
      getFileHash: vi.fn(),
      upsertFileHash: vi.fn(),
      deleteFileHash: vi.fn(),
      getAllFileHashes: vi.fn().mockReturnValue([]),
      deleteNodesByFile: vi.fn(),
      transaction: vi.fn((fn) => fn()),
      getNodeCount: vi.fn().mockReturnValue(0),
      getEdgeCount: vi.fn().mockReturnValue(0),
      setGraphMetadata: vi.fn(),
    };

    const mockParser = {};

    const allFiles: DiscoveredFile[] = [
      {
        absolutePath: '/proj/src/a.ts',
        relativePath: 'src/a.ts',
        extension: 'ts',
        sizeBytes: 100,
        mtimeMs: 1_000_000,
      },
      {
        absolutePath: '/proj/src/b.ts',
        relativePath: 'src/b.ts',
        extension: 'ts',
        sizeBytes: 200,
        mtimeMs: 2_000_000,
      },
    ];

    vi.mocked(discoverFiles).mockResolvedValue(allFiles);
    vi.mocked(resolveIncrementalFiles).mockResolvedValue({
      filesToProcess: [], // No files changed — the no-op trigger
      isIncrementalRun: true,
    });

    const pipeline = new IndexingPipeline(mockDb as never, mockParser as never);

    const options: IndexingOptions = {
      projectRoot: '/proj',
      projectName: 'test-proj',
      incremental: true,
    };

    const result = await pipeline.index(options);

    // Verify the result shape of buildNoOpResult
    expect(result.projectName).toBe('test-proj');
    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(0);
    expect(result.filesSkipped).toBe(2);
    expect(result.nodesCreated).toBe(0);
    expect(result.edgesCreated).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.incremental).toBe(true);
    expect(result.phaseTimingsMs).toEqual({});
  });

  it('skips parsePass and all enrichment passes when filesToProcess is empty', async () => {
    const { resolveIncrementalFiles, discoverFiles } =
      await import('./indexingPipelineIncremental');
    const { parsePass } = await import('./indexingPipelinePasses');
    const { prefetchGitCoChangeData } = await import('./passes/gitCoChangePass');

    const mockDb = {
      getProject: vi.fn().mockReturnValue({ name: 'test-proj' }),
      upsertProject: vi.fn(),
      deleteProject: vi.fn(),
      getFileHash: vi.fn(),
      upsertFileHash: vi.fn(),
      deleteFileHash: vi.fn(),
      getAllFileHashes: vi.fn().mockReturnValue([]),
      deleteNodesByFile: vi.fn(),
      transaction: vi.fn((fn) => fn()),
      getNodeCount: vi.fn().mockReturnValue(100), // Simulate prior indexed nodes
      getEdgeCount: vi.fn().mockReturnValue(50),
      setGraphMetadata: vi.fn(),
    };

    const mockParser = {};

    const allFiles: DiscoveredFile[] = [
      {
        absolutePath: '/proj/src/a.ts',
        relativePath: 'src/a.ts',
        extension: 'ts',
        sizeBytes: 100,
        mtimeMs: 1_000_000,
      },
    ];

    vi.mocked(discoverFiles).mockResolvedValue(allFiles);
    vi.mocked(resolveIncrementalFiles).mockResolvedValue({
      filesToProcess: [],
      isIncrementalRun: true,
    });
    vi.mocked(parsePass).mockResolvedValue([]);
    vi.mocked(prefetchGitCoChangeData).mockResolvedValue(null);

    const pipeline = new IndexingPipeline(mockDb as never, mockParser as never);

    const options: IndexingOptions = {
      projectRoot: '/proj',
      projectName: 'test-proj',
      incremental: true,
    };

    await pipeline.index(options);

    // Verify parsePass was NOT called (the no-op fast-path skips it)
    expect(vi.mocked(parsePass)).not.toHaveBeenCalled();

    // prefetchGitCoChangeData should also not be called in the fast-path
    expect(vi.mocked(prefetchGitCoChangeData)).not.toHaveBeenCalled();
  });

  it('returns 0 durationMs when filesToProcess is empty (timing is instant)', async () => {
    const { resolveIncrementalFiles, discoverFiles } =
      await import('./indexingPipelineIncremental');

    const mockDb = {
      getProject: vi.fn().mockReturnValue({ name: 'test-proj' }),
      upsertProject: vi.fn(),
      deleteProject: vi.fn(),
      getFileHash: vi.fn(),
      upsertFileHash: vi.fn(),
      transaction: vi.fn((fn) => fn()),
      getNodeCount: vi.fn().mockReturnValue(0),
      getEdgeCount: vi.fn().mockReturnValue(0),
      setGraphMetadata: vi.fn(),
    };

    const mockParser = {};

    const allFiles: DiscoveredFile[] = [];

    vi.mocked(discoverFiles).mockResolvedValue(allFiles);
    vi.mocked(resolveIncrementalFiles).mockResolvedValue({
      filesToProcess: [],
      isIncrementalRun: true,
    });

    const pipeline = new IndexingPipeline(mockDb as never, mockParser as never);

    const options: IndexingOptions = {
      projectRoot: '/proj',
      projectName: 'test-proj',
      incremental: true,
    };

    const result = await pipeline.index(options);

    // durationMs should be small (less than 50ms for a no-op)
    expect(result.durationMs).toBeLessThan(50);
  });
});

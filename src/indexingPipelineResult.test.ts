/**
 * indexingPipelineResult.test.ts — Tests for result building.
 */

import { describe, expect, it, vi } from 'vitest';

import { buildIndexResult, buildNoOpResult, type IndexResultOpts } from './indexingPipelineResult';
import type { DiscoveredFile } from './indexingPipelineTypes';
import type { ParsedFileResult } from './treeSitterTypes';

// Helper to create a minimal parsed file result.
// `calls` defaults to 1 so zero-definition files are treated as real source
// (not pure-data-config objects) and still trigger the filesWithoutSymbols check.
// `hasParseError` defaults to false (clean parse).
function createParsedFile(
  definitions: number = 1,
  lineCount: number = 50,
  exportedNames: number = 0,
  calls: number = 1,
  hasParseError: boolean = false,
): ParsedFileResult {
  return {
    definitions: Array(definitions).fill({ name: 'dummy', kind: 'Function' }),
    lineCount,
    exportedNames: Array(exportedNames).fill('dummy'),
    calls: Array(calls).fill({ calleeName: 'dummy', receiverName: null, startLine: 1, isAsync: false, arguments: 0, isNewExpression: false }),
    imports: [],
    hasParseError,
    firstErrorLine: null,
  } as unknown as ParsedFileResult;
}

// Helper to create a mock database
function createMockDb() {
  return {
    setGraphMetadata: vi.fn(),
  };
}

describe('buildIndexResult', () => {
  it('builds a valid IndexingResult with parseAnomalies field', () => {
    const startTime = Date.now();
    const opts: IndexResultOpts = {
      db: createMockDb() as never,
      projectName: 'test-project',
      allFiles: [
        {
          absolutePath: '/test/src/a.ts',
          relativePath: 'src/a.ts',
          extension: 'ts',
          sizeBytes: 1024,
          mtimeMs: Date.now(),
        },
      ],
      filesToProcess: [
        {
          absolutePath: '/test/src/a.ts',
          relativePath: 'src/a.ts',
          extension: 'ts',
          sizeBytes: 1024,
          mtimeMs: Date.now(),
        },
      ],
      indexedFiles: [
        {
          absolutePath: '/test/src/a.ts',
          relativePath: 'src/a.ts',
          extension: 'ts',
          sizeBytes: 1024,
          mtimeMs: Date.now(),
          contentHash: 'abc123',
          parsed: createParsedFile(1, 50),
        },
      ],
      nodesCreated: 10,
      edgesCreated: 5,
      phaseTimingsMs: { discovery: 10, parsing: 20, definitions: 30 },
      progress: {
        phase: 'finalizing',
        filesTotal: 1,
        filesProcessed: 1,
        nodesCreated: 10,
        edgesCreated: 5,
        errors: [],
        startedAt: startTime,
        elapsedMs: 100,
      },
      isIncrementalRun: true,
      passErrors: 0,
      startTime,
    };

    const result = buildIndexResult(opts);

    expect(result.projectName).toBe('test-project');
    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(1);
    expect(result.filesSkipped).toBe(0);
    expect(result.nodesCreated).toBe(10);
    expect(result.edgesCreated).toBe(5);
    expect(result.errors).toEqual([]);
    expect(result.incremental).toBe(true);
    expect(result.phaseTimingsMs).toEqual({
      discovery: 10,
      parsing: 20,
      definitions: 30,
    });
    expect(result.parseAnomalies).toBeDefined();
    expect(result.parseAnomalies!.count).toBe(0);
    expect(result.parseAnomalies!.files).toEqual([]);
    expect(result.parseAnomalies!.filesWithoutSymbols).toEqual({ count: 0, files: [] });
  });

  it('counts a file with hasParseError:true in parseAnomalies.count (genuine parse failure)', () => {
    const startTime = Date.now();
    const opts: IndexResultOpts = {
      db: createMockDb() as never,
      projectName: 'test-project',
      allFiles: [
        {
          absolutePath: '/test/src/broken.ts',
          relativePath: 'src/broken.ts',
          extension: 'ts',
          sizeBytes: 1024,
          mtimeMs: Date.now(),
        },
      ],
      filesToProcess: [
        {
          absolutePath: '/test/src/broken.ts',
          relativePath: 'src/broken.ts',
          extension: 'ts',
          sizeBytes: 1024,
          mtimeMs: Date.now(),
        },
      ],
      indexedFiles: [
        {
          absolutePath: '/test/src/broken.ts',
          relativePath: 'src/broken.ts',
          extension: 'ts',
          sizeBytes: 1024,
          mtimeMs: Date.now(),
          contentHash: 'abc123',
          parsed: createParsedFile(0, 50, 0, 1, /* hasParseError */ true),
        },
      ],
      nodesCreated: 0,
      edgesCreated: 0,
      phaseTimingsMs: {},
      progress: {
        phase: 'finalizing',
        filesTotal: 1,
        filesProcessed: 1,
        nodesCreated: 0,
        edgesCreated: 0,
        errors: [],
        startedAt: startTime,
        elapsedMs: 100,
      },
      isIncrementalRun: false,
      passErrors: 0,
      startTime,
    };

    const result = buildIndexResult(opts);

    // Primary metric: genuine parse errors only
    expect(result.parseAnomalies).toBeDefined();
    expect(result.parseAnomalies!.count).toBe(1);
    expect(result.parseAnomalies!.files).toContain('src/broken.ts');
  });

  it('routes a clean-parse zero-symbol file to filesWithoutSymbols, not parseAnomalies.count', () => {
    const startTime = Date.now();
    const opts: IndexResultOpts = {
      db: createMockDb() as never,
      projectName: 'test-project',
      allFiles: [
        {
          absolutePath: '/test/src/entry.ts',
          relativePath: 'src/entry.ts',
          extension: 'ts',
          sizeBytes: 1024,
          mtimeMs: Date.now(),
        },
      ],
      filesToProcess: [
        {
          absolutePath: '/test/src/entry.ts',
          relativePath: 'src/entry.ts',
          extension: 'ts',
          sizeBytes: 1024,
          mtimeMs: Date.now(),
        },
      ],
      indexedFiles: [
        {
          absolutePath: '/test/src/entry.ts',
          relativePath: 'src/entry.ts',
          extension: 'ts',
          sizeBytes: 1024,
          mtimeMs: Date.now(),
          contentHash: 'abc123',
          parsed: createParsedFile(0, 50, 0, 1, /* hasParseError */ false), // zero defs, clean parse
        },
      ],
      nodesCreated: 0,
      edgesCreated: 0,
      phaseTimingsMs: {},
      progress: {
        phase: 'finalizing',
        filesTotal: 1,
        filesProcessed: 1,
        nodesCreated: 0,
        edgesCreated: 0,
        errors: [],
        startedAt: startTime,
        elapsedMs: 100,
      },
      isIncrementalRun: false,
      passErrors: 0,
      startTime,
    };

    const result = buildIndexResult(opts);

    // parseAnomalies.count must be 0 — no ERROR/MISSING nodes
    expect(result.parseAnomalies!.count).toBe(0);
    expect(result.parseAnomalies!.files).toEqual([]);
    // The file appears in the informational secondary metric instead
    expect(result.parseAnomalies!.filesWithoutSymbols.count).toBe(1);
    expect(result.parseAnomalies!.filesWithoutSymbols.files).toContain('src/entry.ts');
  });

  it('calculates filesSkipped correctly', () => {
    const startTime = Date.now();
    const opts: IndexResultOpts = {
      db: createMockDb() as never,
      projectName: 'test-project',
      allFiles: Array(10)
        .fill(null)
        .map((_, i) => ({
          absolutePath: `/test/src/f${i}.ts`,
          relativePath: `src/f${i}.ts`,
          extension: 'ts',
          sizeBytes: 1024,
          mtimeMs: Date.now(),
        })),
      filesToProcess: Array(3)
        .fill(null)
        .map((_, i) => ({
          absolutePath: `/test/src/f${i}.ts`,
          relativePath: `src/f${i}.ts`,
          extension: 'ts',
          sizeBytes: 1024,
          mtimeMs: Date.now(),
        })),
      indexedFiles: Array(3)
        .fill(null)
        .map((_, i) => ({
          absolutePath: `/test/src/f${i}.ts`,
          relativePath: `src/f${i}.ts`,
          extension: 'ts',
          sizeBytes: 1024,
          mtimeMs: Date.now(),
          contentHash: 'abc123',
          parsed: createParsedFile(1, 50),
        })),
      nodesCreated: 5,
      edgesCreated: 2,
      phaseTimingsMs: {},
      progress: {
        phase: 'finalizing',
        filesTotal: 10,
        filesProcessed: 3,
        nodesCreated: 5,
        edgesCreated: 2,
        errors: [],
        startedAt: startTime,
        elapsedMs: 100,
      },
      isIncrementalRun: true,
      passErrors: 0,
      startTime,
    };

    const result = buildIndexResult(opts);

    expect(result.filesIndexed).toBe(3);
    expect(result.filesSkipped).toBe(7);
  });
});

// ─── buildNoOpResult ──────────────────────────────────────────────────────────

describe('buildNoOpResult', () => {
  it('returns an IndexingResult with success=true and 0 files processed', () => {
    const allFiles: DiscoveredFile[] = [
      {
        absolutePath: '/test/src/a.ts',
        relativePath: 'src/a.ts',
        extension: 'ts',
        sizeBytes: 100,
        mtimeMs: 1_000_000,
      },
      {
        absolutePath: '/test/src/b.ts',
        relativePath: 'src/b.ts',
        extension: 'ts',
        sizeBytes: 200,
        mtimeMs: 2_000_000,
      },
    ];
    const startTime = Date.now();
    const progress = {
      phase: 'discovery',
      filesTotal: 2,
      filesProcessed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [],
      startedAt: startTime,
      elapsedMs: 10,
    };

    const result = buildNoOpResult('test-proj', allFiles, progress, startTime);

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

  it('carries errors from progress into the result', () => {
    const allFiles: DiscoveredFile[] = [
      {
        absolutePath: '/test/src/a.ts',
        relativePath: 'src/a.ts',
        extension: 'ts',
        sizeBytes: 100,
        mtimeMs: 1_000_000,
      },
    ];
    const startTime = Date.now();
    const progress = {
      phase: 'discovery',
      filesTotal: 1,
      filesProcessed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: ['Parse error in file X', 'IO error reading file Y'],
      startedAt: startTime,
      elapsedMs: 10,
    };

    const result = buildNoOpResult('test-proj', allFiles, progress, startTime);

    expect(result.errors).toEqual(['Parse error in file X', 'IO error reading file Y']);
  });

  it('returns filesSkipped equal to allFiles.length when allFiles is empty', () => {
    const startTime = Date.now();
    const progress = {
      phase: 'discovery',
      filesTotal: 0,
      filesProcessed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [],
      startedAt: startTime,
      elapsedMs: 0,
    };

    const result = buildNoOpResult('test-proj', [], progress, startTime);

    expect(result.filesSkipped).toBe(0);
    expect(result.filesIndexed).toBe(0);
  });

  it('calculates durationMs as Date.now() - startTime', () => {
    const startTime = Date.now();
    const allFiles: DiscoveredFile[] = [];
    const progress = {
      phase: 'discovery',
      filesTotal: 0,
      filesProcessed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [],
      startedAt: startTime,
      elapsedMs: 0,
    };

    const result = buildNoOpResult('test-proj', allFiles, progress, startTime);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(100); // Should be near-instant
  });

  it('always sets incremental=true for no-op results', () => {
    const startTime = Date.now();
    const progress = {
      phase: 'discovery',
      filesTotal: 0,
      filesProcessed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [],
      startedAt: startTime,
      elapsedMs: 0,
    };

    const result = buildNoOpResult('test-proj', [], progress, startTime);

    expect(result.incremental).toBe(true);
  });

  it('returns empty phaseTimingsMs object for no-op results', () => {
    const startTime = Date.now();
    const progress = {
      phase: 'discovery',
      filesTotal: 0,
      filesProcessed: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [],
      startedAt: startTime,
      elapsedMs: 0,
    };

    const result = buildNoOpResult('test-proj', [], progress, startTime);

    expect(result.phaseTimingsMs).toEqual({});
  });
});

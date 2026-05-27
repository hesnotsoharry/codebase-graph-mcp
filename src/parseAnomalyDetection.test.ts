/**
 * parseAnomalyDetection.test.ts — Tests for parse anomaly detection.
 */

import { describe, expect, it } from 'vitest';

import type { IndexedFile } from './indexingPipelineTypes';
import { countParseAnomalies } from './parseAnomalyDetection';
import type { ParsedFileResult } from './treeSitterTypes';

// Helper to create a minimal IndexedFile for testing
function createIndexedFile(
  relativePath: string,
  parsed: ParsedFileResult | null,
): IndexedFile {
  return {
    absolutePath: `/test/${relativePath}`,
    relativePath,
    extension: 'ts',
    sizeBytes: 1024,
    mtimeMs: Date.now(),
    contentHash: 'abc123',
    parsed,
  };
}

// Helper to create a minimal ParsedFileResult
function createParsedFile(
  definitions: number = 0,
  lineCount: number = 50,
  exportedNames: number = 0,
): ParsedFileResult {
  return {
    definitions: Array(definitions).fill({ name: 'dummy', kind: 'Function' }),
    lineCount,
    exportedNames: Array(exportedNames).fill('dummy'),
    imports: [],
  } as unknown as ParsedFileResult;
}

describe('countParseAnomalies', () => {
  it('returns {count: 0, samples: []} when no files have anomalies', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/valid.ts', createParsedFile(1, 50)), // has definitions
      createIndexedFile('src/empty.ts', null), // null parsed (unreadable)
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.samples).toEqual([]);
  });

  it('counts one file with zero definitions as an anomaly', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/anomaly.ts', createParsedFile(0, 50, 0)), // no definitions
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(1);
    expect(result.samples).toEqual(['src/anomaly.ts']);
  });

  it('excludes files with lineCount <= 30 (small config files)', () => {
    const files: IndexedFile[] = [
      createIndexedFile('config.ts', createParsedFile(0, 30, 0)), // at threshold
      createIndexedFile('index.ts', createParsedFile(0, 20, 0)), // below threshold
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.samples).toEqual([]);
  });

  it('includes files with lineCount > 30', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/real.ts', createParsedFile(0, 31, 0)), // just above threshold
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(1);
    expect(result.samples).toEqual(['src/real.ts']);
  });

  it('excludes files with exportedNames.length > 0 (re-export barrels)', () => {
    const files: IndexedFile[] = [
      createIndexedFile('index.ts', createParsedFile(0, 50, 1)), // has exported names (re-export)
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.samples).toEqual([]);
  });

  it('includes files with exportedNames.length === 0', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/main.ts', createParsedFile(0, 50, 0)), // no exported names
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(1);
    expect(result.samples).toEqual(['src/main.ts']);
  });

  it('caps samples at 5 even when count is larger', () => {
    const files: IndexedFile[] = [
      createIndexedFile('a.ts', createParsedFile(0, 50, 0)),
      createIndexedFile('b.ts', createParsedFile(0, 50, 0)),
      createIndexedFile('c.ts', createParsedFile(0, 50, 0)),
      createIndexedFile('d.ts', createParsedFile(0, 50, 0)),
      createIndexedFile('e.ts', createParsedFile(0, 50, 0)),
      createIndexedFile('f.ts', createParsedFile(0, 50, 0)),
      createIndexedFile('g.ts', createParsedFile(0, 50, 0)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(7);
    expect(result.samples).toHaveLength(5);
    expect(result.samples).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
  });

  it('returns samples sorted alphabetically', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/zebra.ts', createParsedFile(0, 50, 0)),
      createIndexedFile('src/apple.ts', createParsedFile(0, 50, 0)),
      createIndexedFile('src/middle.ts', createParsedFile(0, 50, 0)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(3);
    expect(result.samples).toEqual(['src/apple.ts', 'src/middle.ts', 'src/zebra.ts']);
  });

  it('excludes files where parsed is null', () => {
    const files: IndexedFile[] = [
      createIndexedFile('readable.ts', createParsedFile(0, 50, 0)), // parsed anomaly
      createIndexedFile('unreadable.ts', null), // parsed is null (not an anomaly)
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(1);
    expect(result.samples).toEqual(['readable.ts']);
  });

  it('returns empty samples when no anomalies exist', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/ok1.ts', createParsedFile(1, 50, 0)),
      createIndexedFile('src/ok2.ts', createParsedFile(2, 50, 0)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.samples).toEqual([]);
  });
});

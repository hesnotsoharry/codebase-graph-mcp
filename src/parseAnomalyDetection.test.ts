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

// Helper to create a minimal ParsedFileResult.
// `calls` defaults to 1 so test files are treated as real source files
// (not pure-data-config objects) unless the test is specifically checking the
// zero-calls+zero-imports suppression path.
function createParsedFile(
  definitions: number = 0,
  lineCount: number = 50,
  exportedNames: number = 0,
  calls: number = 1,
  imports: number = 0,
): ParsedFileResult {
  return {
    definitions: Array(definitions).fill({ name: 'dummy', kind: 'Function' }),
    lineCount,
    exportedNames: Array(exportedNames).fill('dummy'),
    calls: Array(calls).fill({ calleeName: 'dummy', receiverName: null, startLine: 1, isAsync: false, arguments: 0, isNewExpression: false }),
    imports: Array(imports).fill({ source: './dummy', specifiers: [], isTypeOnly: false, startLine: 1, endLine: 1 }),
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
    expect(result.files).toEqual([]);
  });

  it('counts one file with zero definitions as an anomaly', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/anomaly.ts', createParsedFile(0, 50, 0)), // no definitions
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(1);
    expect(result.files).toEqual(['src/anomaly.ts']);
  });

  it('excludes files with lineCount <= 30 (small config files)', () => {
    const files: IndexedFile[] = [
      createIndexedFile('config.ts', createParsedFile(0, 30, 0)), // at threshold
      createIndexedFile('index.ts', createParsedFile(0, 20, 0)), // below threshold
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('includes files with lineCount > 30', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/real.ts', createParsedFile(0, 31, 0)), // just above threshold
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(1);
    expect(result.files).toEqual(['src/real.ts']);
  });

  it('excludes files with exportedNames.length > 0 (re-export barrels)', () => {
    const files: IndexedFile[] = [
      createIndexedFile('index.ts', createParsedFile(0, 50, 1)), // has exported names (re-export)
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('includes files with exportedNames.length === 0', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/main.ts', createParsedFile(0, 50, 0)), // no exported names
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(1);
    expect(result.files).toEqual(['src/main.ts']);
  });

  it('returns the full list of anomalous files with no cap', () => {
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
    expect(result.files).toHaveLength(7);
    expect(result.files).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']);
  });

  it('returns samples sorted alphabetically', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/zebra.ts', createParsedFile(0, 50, 0)),
      createIndexedFile('src/apple.ts', createParsedFile(0, 50, 0)),
      createIndexedFile('src/middle.ts', createParsedFile(0, 50, 0)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(3);
    expect(result.files).toEqual(['src/apple.ts', 'src/middle.ts', 'src/zebra.ts']);
  });

  it('excludes files where parsed is null', () => {
    const files: IndexedFile[] = [
      createIndexedFile('readable.ts', createParsedFile(0, 50, 0)), // parsed anomaly
      createIndexedFile('unreadable.ts', null), // parsed is null (not an anomaly)
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(1);
    expect(result.files).toEqual(['readable.ts']);
  });

  it('returns empty samples when no anomalies exist', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/ok1.ts', createParsedFile(1, 50, 0)),
      createIndexedFile('src/ok2.ts', createParsedFile(2, 50, 0)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });

  // ─── Pure-data-config suppression (Fix 3b) ───────────────────────────────

  it('does NOT flag a zero-def file that also has zero calls and zero imports (pure data-config object)', () => {
    // .dependency-cruiser.cjs and similar hook .mjs files parse cleanly but have
    // zero named functions, zero call expressions, and zero import statements.
    const files: IndexedFile[] = [
      createIndexedFile('.dependency-cruiser.cjs', createParsedFile(0, 50, 0, 0, 0)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('does NOT flag a zero-def file that has imports but zero calls when it matches a config filename pattern', () => {
    // vitest.config.ts may import defineConfig but emit zero definitions — config pattern suppresses it.
    const files: IndexedFile[] = [
      createIndexedFile('vitest.config.ts', createParsedFile(0, 50, 0, 0, 1)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('does NOT flag jest.config.js regardless of call count', () => {
    const files: IndexedFile[] = [
      createIndexedFile('jest.config.js', createParsedFile(0, 50, 0, 2, 1)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('does NOT flag a generic *.config.ts file matching the config filename pattern', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/webpack.config.ts', createParsedFile(0, 50, 0, 0, 1)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('still flags a zero-def source file that has calls but does not match a config filename', () => {
    // A real source file that tree-sitter failed to extract definitions from
    // (genuine regression) must still be flagged even with calls present.
    const files: IndexedFile[] = [
      createIndexedFile('src/brokenModule.ts', createParsedFile(0, 50, 0, 3, 2)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(1);
    expect(result.files).toEqual(['src/brokenModule.ts']);
  });

  it('still flags a zero-def source file that has imports but no calls and does not match a config filename', () => {
    // A module that only imports (and re-uses them at runtime, not as definitions)
    // but has no call expressions — still a potential parser anomaly if it looks
    // like real source code. Config-file suppression should not fire here.
    const files: IndexedFile[] = [
      createIndexedFile('src/dataOnly.ts', createParsedFile(0, 50, 0, 0, 2)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(1);
    expect(result.files).toEqual(['src/dataOnly.ts']);
  });
});

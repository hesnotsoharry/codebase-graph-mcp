/**
 * parseAnomalyDetection.test.ts — Tests for the two-metric parse health report.
 *
 * Metric 1 (primary): `parseAnomalies` — files where tree-sitter produced
 *   ERROR/MISSING nodes (hasParseError === true). Expected ~0.
 *
 * Metric 2 (secondary): `filesWithoutSymbols` — clean-parse files that emitted
 *   zero definitions/exports, after suppression of known zero-symbol patterns.
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
// `hasParseError` defaults to false (clean parse).
function createParsedFile(
  definitions: number = 0,
  lineCount: number = 50,
  exportedNames: number = 0,
  calls: number = 1,
  imports: number = 0,
  hasParseError: boolean = false,
  firstErrorLine: number | null = null,
): ParsedFileResult {
  return {
    definitions: Array(definitions).fill({ name: 'dummy', kind: 'Function' }),
    lineCount,
    exportedNames: Array(exportedNames).fill('dummy'),
    calls: Array(calls).fill({ calleeName: 'dummy', receiverName: null, startLine: 1, isAsync: false, arguments: 0, isNewExpression: false }),
    imports: Array(imports).fill({ source: './dummy', specifiers: [], isTypeOnly: false, startLine: 1, endLine: 1 }),
    hasParseError,
    firstErrorLine,
  } as unknown as ParsedFileResult;
}

// ─── PRIMARY METRIC: parse errors (ERROR/MISSING nodes) ──────────────────────

describe('countParseAnomalies — primary metric (genuine parse errors)', () => {
  it('counts a file with hasParseError:true in parseAnomalies, not filesWithoutSymbols', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/broken.ts', createParsedFile(0, 50, 0, 1, 0, true, 12)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(1);
    expect(result.files).toEqual(['src/broken.ts']);
    // A file in parseAnomalies must NOT also appear in filesWithoutSymbols
    expect(result.filesWithoutSymbols.files).not.toContain('src/broken.ts');
  });

  it('counts zero parseAnomalies when all files have clean parse trees', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/clean.ts', createParsedFile(2, 50, 1, 3, 2, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('an import.meta entry file (hasParseError:false) is NOT counted in parseAnomalies', () => {
    // import.meta is a meta_property node — tree-sitter handles it cleanly
    const files: IndexedFile[] = [
      createIndexedFile('src/main.tsx', createParsedFile(0, 80, 0, 5, 3, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('a shebang .mjs hook file under a hooks dir is NOT counted in parseAnomalies', () => {
    // shebang (hash_bang_line) parses cleanly; hook scripts have no defs
    const files: IndexedFile[] = [
      createIndexedFile('.claude/hooks/my-hook.mjs', createParsedFile(0, 45, 0, 2, 3, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('a service worker (sw.js, clean parse) is NOT counted in parseAnomalies', () => {
    const files: IndexedFile[] = [
      createIndexedFile('public/sw.js', createParsedFile(0, 60, 0, 4, 0, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('a data file using Object.freeze (clean parse) is NOT counted in parseAnomalies', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/config.data.ts', createParsedFile(0, 35, 0, 1, 0, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('a file with hasParseError:true is counted in parseAnomalies even when it has definitions', () => {
    // Partial parse: tree-sitter emitted some definitions but also has ERROR nodes
    const files: IndexedFile[] = [
      createIndexedFile('src/partial.ts', createParsedFile(2, 80, 1, 5, 3, true, 55)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(1);
    expect(result.files).toEqual(['src/partial.ts']);
  });

  it('returns both files sorted alphabetically in parseAnomalies', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/zebra.ts', createParsedFile(0, 50, 0, 1, 0, true, 5)),
      createIndexedFile('src/apple.ts', createParsedFile(0, 50, 0, 1, 0, true, 3)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(2);
    expect(result.files).toEqual(['src/apple.ts', 'src/zebra.ts']);
  });

  it('excludes files where parsed is null from both metrics', () => {
    const files: IndexedFile[] = [
      createIndexedFile('unreadable.ts', null),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.filesWithoutSymbols.count).toBe(0);
  });
});

// ─── SECONDARY METRIC: filesWithoutSymbols ────────────────────────────────────

describe('countParseAnomalies — secondary metric (filesWithoutSymbols)', () => {
  it('a clean-parse zero-symbol file NOT matching any suppression pattern appears in filesWithoutSymbols', () => {
    // This is the "genuine extractor gap" signal — the file looks like real source
    // code (has calls/imports) but the extractor found no definitions.
    const files: IndexedFile[] = [
      createIndexedFile('src/dataOnly.ts', createParsedFile(0, 50, 0, 0, 2, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0); // NOT a parse error
    expect(result.filesWithoutSymbols.count).toBe(1);
    expect(result.filesWithoutSymbols.files).toEqual(['src/dataOnly.ts']);
  });

  it('a hook file under a /hooks/ directory is suppressed from filesWithoutSymbols', () => {
    const files: IndexedFile[] = [
      // .claude/hooks/ path — matches the hooks suppression pattern
      createIndexedFile('.claude/hooks/agent_catalog_enforce.mjs', createParsedFile(0, 60, 0, 3, 4, false, null)),
      // assets/hooks/ path
      createIndexedFile('assets/hooks/pre-commit.js', createParsedFile(0, 40, 0, 2, 1, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.filesWithoutSymbols.count).toBe(0);
    expect(result.filesWithoutSymbols.files).toEqual([]);
  });

  it('a service worker (sw.js) is suppressed from filesWithoutSymbols', () => {
    const files: IndexedFile[] = [
      createIndexedFile('public/sw.js', createParsedFile(0, 60, 0, 4, 0, false, null)),
      createIndexedFile('src/service-worker.js', createParsedFile(0, 55, 0, 6, 0, false, null)),
      createIndexedFile('src/serviceWorker.js', createParsedFile(0, 48, 0, 3, 0, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.filesWithoutSymbols.count).toBe(0);
    expect(result.filesWithoutSymbols.files).toEqual([]);
  });

  it('a data/constants file is suppressed from filesWithoutSymbols', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/theme.data.ts', createParsedFile(0, 35, 0, 1, 0, false, null)),
      createIndexedFile('src/colors.constants.ts', createParsedFile(0, 45, 0, 1, 0, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.filesWithoutSymbols.count).toBe(0);
    expect(result.filesWithoutSymbols.files).toEqual([]);
  });

  it('excludes files with lineCount <= 30 from filesWithoutSymbols (too small to be a concern)', () => {
    const files: IndexedFile[] = [
      createIndexedFile('config.ts', createParsedFile(0, 30, 0, 1, 0, false, null)),
      createIndexedFile('index.ts', createParsedFile(0, 20, 0, 1, 0, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.filesWithoutSymbols.count).toBe(0);
  });

  it('excludes pure data-config objects (zero calls AND zero imports) from filesWithoutSymbols', () => {
    const files: IndexedFile[] = [
      createIndexedFile('.dependency-cruiser.cjs', createParsedFile(0, 50, 0, 0, 0, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.filesWithoutSymbols.count).toBe(0);
  });

  it('excludes re-export barrels (exportedNames > 0) from filesWithoutSymbols', () => {
    const files: IndexedFile[] = [
      createIndexedFile('index.ts', createParsedFile(0, 50, 1, 0, 2, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.filesWithoutSymbols.count).toBe(0);
  });

  it('config filename patterns (*.config.ts) are suppressed from filesWithoutSymbols', () => {
    const files: IndexedFile[] = [
      createIndexedFile('vitest.config.ts', createParsedFile(0, 50, 0, 0, 1, false, null)),
      createIndexedFile('jest.config.js', createParsedFile(0, 50, 0, 2, 1, false, null)),
      createIndexedFile('src/webpack.config.ts', createParsedFile(0, 50, 0, 0, 1, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.filesWithoutSymbols.count).toBe(0);
  });

  it('still flags a zero-def source file with calls that is NOT a suppressed pattern in filesWithoutSymbols', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/brokenModule.ts', createParsedFile(0, 50, 0, 3, 2, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0); // Not a parse error
    expect(result.filesWithoutSymbols.count).toBe(1);
    expect(result.filesWithoutSymbols.files).toEqual(['src/brokenModule.ts']);
  });

  it('returns filesWithoutSymbols sorted alphabetically', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/zebra.ts', createParsedFile(0, 50, 0, 1, 0, false, null)),
      createIndexedFile('src/apple.ts', createParsedFile(0, 50, 0, 1, 0, false, null)),
      createIndexedFile('src/middle.ts', createParsedFile(0, 50, 0, 1, 0, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.filesWithoutSymbols.count).toBe(3);
    expect(result.filesWithoutSymbols.files).toEqual(['src/apple.ts', 'src/middle.ts', 'src/zebra.ts']);
  });
});

// ─── COMBINED: both metrics at once ──────────────────────────────────────────

describe('countParseAnomalies — combined metrics', () => {
  it('correctly separates a parse-error file from a zero-symbol file in the same batch', () => {
    const files: IndexedFile[] = [
      // This one has ERROR nodes — goes into parseAnomalies only
      createIndexedFile('src/broken.ts', createParsedFile(0, 50, 0, 1, 0, true, 10)),
      // This one is clean but zero-symbol — goes into filesWithoutSymbols only
      createIndexedFile('src/entry.ts', createParsedFile(0, 50, 0, 1, 0, false, null)),
      // This one is fine — appears in neither
      createIndexedFile('src/ok.ts', createParsedFile(3, 50, 2, 5, 3, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(1);
    expect(result.files).toEqual(['src/broken.ts']);
    expect(result.filesWithoutSymbols.count).toBe(1);
    expect(result.filesWithoutSymbols.files).toEqual(['src/entry.ts']);
  });

  it('returns zero for both metrics when all files are healthy', () => {
    const files: IndexedFile[] = [
      createIndexedFile('src/ok1.ts', createParsedFile(1, 50, 0, 0, 0, false, null)),
      createIndexedFile('src/ok2.ts', createParsedFile(2, 50, 0, 0, 0, false, null)),
    ];
    const result = countParseAnomalies(files);
    expect(result.count).toBe(0);
    expect(result.filesWithoutSymbols.count).toBe(0);
  });
});

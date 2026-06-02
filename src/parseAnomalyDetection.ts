/**
 * parseAnomalyDetection.ts — Two-metric parse health reporting.
 *
 * Metric 1 — `parseAnomalies` (PRIMARY): files where tree-sitter produced
 *   ERROR or MISSING nodes (`hasParseError === true`). These are genuine
 *   grammar failures. Expected count is ~0 on a healthy codebase.
 *
 * Metric 2 — `filesWithoutSymbols` (INFORMATIONAL): files that parsed cleanly
 *   but emitted zero definitions, zero exports, are longer than
 *   MIN_LINES_FOR_SYMBOL_CHECK lines, and have at least one call or import
 *   (so pure data-config objects are excluded). After suppression of well-known
 *   zero-symbol file patterns (config files, hooks scripts, service workers,
 *   data/constant files), any remaining entries are possible extractor gaps —
 *   NOT parse failures.
 *
 * Extracted from the indexing pipeline to provide a permanent regression guard.
 */

import type { IndexedFile } from './indexingPipelineTypes';

const MIN_LINES_FOR_SYMBOL_CHECK = 30;

/**
 * Filename patterns for files that legitimately produce zero definitions.
 * These are suppressed from the `filesWithoutSymbols` informational metric.
 *
 * The patterns cover:
 *   - Generic *.config.{js,ts,cjs,mjs} (vitest.config.ts, jest.config.js, …)
 *   - .dependency-cruiser.{cjs,js,mjs,ts} (dot-prefixed convention)
 *   - Hook scripts in any hooks directory (.claude/hooks/, assets/hooks/,
 *     or any /hooks/ path segment) with .mjs or .js extension
 *   - Service workers (sw.js, service-worker.js, serviceWorker.js)
 *   - Data / constant files (*.data.*, *.constants.*)
 */
const SUPPRESSED_FILENAME_PATTERNS: RegExp[] = [
  // Config files
  /\.config\.[cm]?[jt]s$/,
  /(?:^|[\\/])\.dependency-cruiser\.[cm]?[jt]s$/,
  /(?:^|[\\/])vitest\.config\.[cm]?[jt]s$/,
  /(?:^|[\\/])jest\.config\.[cm]?[jt]s$/,
  // Hook scripts in any directory named "hooks"
  /(?:^|[\\/])hooks[\\/][^/\\]+\.[cm]?js$/,
  // Service workers
  /(?:^|[\\/])(?:sw|service-?[Ww]orker)\.js$/,
  // Data / constant files
  /\.(?:data|constants)\.[cm]?[jt]s$/,
];

/** Returns true when the relative path matches a known zero-symbol file pattern. */
function isSuppressedFile(relativePath: string): boolean {
  return SUPPRESSED_FILENAME_PATTERNS.some((re) => re.test(relativePath));
}

export interface ParseAnomalyResult {
  /**
   * Count of files with genuine tree-sitter parse errors (ERROR/MISSING nodes).
   * This is the primary health signal. Expected to be ~0.
   */
  count: number;
  /**
   * Complete sorted list of relative paths with parse errors.
   */
  files: string[];
  /**
   * Informational secondary metric: files that parsed cleanly but emitted
   * zero definitions and zero exports (possible extractor gaps). Not parse
   * failures. After suppression of known zero-symbol patterns.
   */
  filesWithoutSymbols: {
    count: number;
    files: string[];
  };
}

/**
 * Analyses `indexedFiles` and returns the two-metric parse health report.
 *
 * Primary metric (`count` / `files`):
 *   Files where `hasParseError === true` (genuine tree-sitter ERROR/MISSING nodes).
 *
 * Secondary metric (`filesWithoutSymbols`):
 *   Files that:
 *     - parsed cleanly (hasParseError === false)
 *     - have zero definitions AND zero exports
 *     - are longer than MIN_LINES_FOR_SYMBOL_CHECK lines
 *     - have at least one call or import (not pure data-config objects)
 *     - do NOT match a known suppression pattern
 */
export function countParseAnomalies(indexedFiles: IndexedFile[]): ParseAnomalyResult {
  const parseErrors: string[] = [];
  const withoutSymbols: string[] = [];

  for (const file of indexedFiles) {
    if (file.parsed === null) continue;

    // Primary metric: genuine parse failures
    if (file.parsed.hasParseError) {
      parseErrors.push(file.relativePath);
      continue; // A file with parse errors is already the primary signal;
                 // don't also count it as a zero-symbol file
    }

    // Secondary metric: clean parse, but zero symbols extracted
    if (file.parsed.definitions.length > 0) continue;
    if (file.parsed.lineCount <= MIN_LINES_FOR_SYMBOL_CHECK) continue;
    if (file.parsed.exportedNames.length > 0) continue;
    // Exclude pure data-config objects: zero calls AND zero imports
    if (file.parsed.calls.length === 0 && file.parsed.imports.length === 0) continue;
    // Suppress known zero-symbol file patterns
    if (isSuppressedFile(file.relativePath)) continue;

    withoutSymbols.push(file.relativePath);
  }

  parseErrors.sort();
  withoutSymbols.sort();

  return {
    count: parseErrors.length,
    files: parseErrors,
    filesWithoutSymbols: {
      count: withoutSymbols.length,
      files: withoutSymbols,
    },
  };
}

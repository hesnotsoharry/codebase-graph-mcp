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
export declare function countParseAnomalies(indexedFiles: IndexedFile[]): ParseAnomalyResult;
//# sourceMappingURL=parseAnomalyDetection.d.ts.map
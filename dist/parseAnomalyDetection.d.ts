/**
 * parseAnomalyDetection.ts — Detection for files processed but emitting zero definitions.
 *
 * Extracted from the indexing pipeline to provide a permanent regression guard.
 * Files matching the anomaly criteria are counted and sampled for `index_status` output.
 */
import type { IndexedFile } from './indexingPipelineTypes';
export interface ParseAnomalyResult {
    count: number;
    files: string[];
}
/**
 * Counts files where:
 *   - parsed != null (file was processed, not unreadable)
 *   - parsed.definitions.length === 0 (no definitions emitted)
 *   - lineCount > MIN_LINES_FOR_ANOMALY_CHECK (exclude small config/index barrels)
 *   - exportedNames.length === 0 (exclude pure re-export barrels)
 *   - NOT a pure data-config object (zero definitions AND zero calls AND zero imports)
 *   - NOT matching a known config filename pattern
 *
 * Returns count + the complete sorted list of anomalous relative paths.
 */
export declare function countParseAnomalies(indexedFiles: IndexedFile[]): ParseAnomalyResult;
//# sourceMappingURL=parseAnomalyDetection.d.ts.map
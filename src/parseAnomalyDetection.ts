/**
 * parseAnomalyDetection.ts — Detection for files processed but emitting zero definitions.
 *
 * Extracted from the indexing pipeline to provide a permanent regression guard.
 * Files matching the anomaly criteria are counted and sampled for `index_status` output.
 */

import type { IndexedFile } from './indexingPipelineTypes';

const MIN_LINES_FOR_ANOMALY_CHECK = 30;

export interface ParseAnomalyResult {
  count: number;
  samples: string[]; // up to 5 paths
}

/**
 * Counts files where:
 *   - parsed != null (file was processed, not unreadable)
 *   - parsed.definitions.length === 0 (no definitions emitted)
 *   - lineCount > MIN_LINES_FOR_ANOMALY_CHECK (exclude small config/index barrels)
 *   - exportedNames.length === 0 (exclude pure re-export barrels)
 *
 * Returns count + up to 5 sample relativePaths (sorted alphabetically).
 */
export function countParseAnomalies(indexedFiles: IndexedFile[]): ParseAnomalyResult {
  const anomalies: string[] = [];

  for (const file of indexedFiles) {
    if (file.parsed === null) continue;
    if (file.parsed.definitions.length > 0) continue;
    if (file.parsed.lineCount <= MIN_LINES_FOR_ANOMALY_CHECK) continue;
    if (file.parsed.exportedNames.length > 0) continue;

    anomalies.push(file.relativePath);
  }

  anomalies.sort();
  const samples = anomalies.slice(0, 5);

  return {
    count: anomalies.length,
    samples,
  };
}

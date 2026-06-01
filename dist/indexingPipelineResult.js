/**
 * indexingPipelineResult.ts — Result building for the indexing pipeline.
 *
 * Extracted from indexingPipeline.ts to keep the main file under the 300-line limit.
 */
import { countParseAnomalies } from './parseAnomalyDetection.js';
export function buildIndexResult(opts) {
    const parseAnomalies = countParseAnomalies(opts.indexedFiles);
    opts.db.setGraphMetadata(`parse_anomalies:${opts.projectName}`, JSON.stringify(parseAnomalies));
    return {
        projectName: opts.projectName,
        success: true,
        filesIndexed: opts.indexedFiles.length,
        filesSkipped: opts.allFiles.length - opts.filesToProcess.length,
        nodesCreated: opts.nodesCreated,
        edgesCreated: opts.edgesCreated,
        errors: opts.progress.errors,
        durationMs: Date.now() - opts.startTime,
        incremental: opts.isIncrementalRun,
        phaseTimingsMs: opts.phaseTimingsMs,
        passErrors: opts.passErrors,
        parseAnomalies,
    };
}
/** Builds the no-op IndexingResult used when 0 files changed in an incremental run. */
export function buildNoOpResult(projectName, allFiles, progress, startTime) {
    return {
        projectName,
        success: true,
        filesIndexed: 0,
        filesSkipped: allFiles.length,
        nodesCreated: 0,
        edgesCreated: 0,
        errors: progress.errors,
        durationMs: Date.now() - startTime,
        incremental: true,
        phaseTimingsMs: {},
    };
}
//# sourceMappingURL=indexingPipelineResult.js.map
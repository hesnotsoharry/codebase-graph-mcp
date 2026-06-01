/**
 * indexingPipelineResult.ts — Result building for the indexing pipeline.
 *
 * Extracted from indexingPipeline.ts to keep the main file under the 300-line limit.
 */
import type { GraphDatabase } from './graphDatabase';
import type { DiscoveredFile, IndexedFile, IndexingProgress, IndexingResult } from './indexingPipelineTypes';
export interface IndexResultOpts {
    db: GraphDatabase;
    projectName: string;
    allFiles: DiscoveredFile[];
    filesToProcess: DiscoveredFile[];
    indexedFiles: IndexedFile[];
    nodesCreated: number;
    edgesCreated: number;
    phaseTimingsMs: Record<string, number>;
    passErrors: number;
    progress: IndexingProgress;
    isIncrementalRun: boolean;
    startTime: number;
}
export declare function buildIndexResult(opts: IndexResultOpts): IndexingResult;
/** Builds the no-op IndexingResult used when 0 files changed in an incremental run. */
export declare function buildNoOpResult(projectName: string, allFiles: DiscoveredFile[], progress: IndexingProgress, startTime: number): IndexingResult;
//# sourceMappingURL=indexingPipelineResult.d.ts.map
/**
 * indexingPipeline.ts — Multi-pass project indexer.
 *
 * NOTE: Normally invoked via indexingWorkerClient (worker thread).
 * This class is still directly usable for tests and one-off scripting.
 *
 * Walks a project directory, parses every supported source file with tree-sitter,
 * and populates the SQLite property graph with nodes and edges. Supports incremental
 * reindexing via stat-based fast path + SHA-256 content hash verification.
 *
 * Pass sequence:
 *   0. File Discovery   — walk directory, respect ignores, apply size/count caps
 *   1. Structure Pass   — Project, Folder, File nodes + containment edges
 *   2. Parse Pass       — tree-sitter parse all files -> ParsedFileResult[]
 *   3. Definition Pass  — Function/Class/Interface/Type/Enum/Method/Route nodes
 *   4. Import Pass      — resolve imports, create IMPORTS edges + Package nodes
 *   5. Call Resolution  — resolve call expressions, create CALLS/ASYNC_CALLS edges
 *   6. Finalize         — update file hashes + project stats
 *
 * File discovery and incremental helpers live in indexingPipelineIncremental.ts.
 */
import { GraphDatabase } from './graphDatabase';
import type { IndexingOptions, IndexingResult } from './indexingPipelineTypes';
import { TreeSitterParser } from './treeSitterParser';
export declare class IndexingPipeline {
    private db;
    private parser;
    constructor(db: GraphDatabase, parser: TreeSitterParser);
    private runPass;
    private runChunkedPass;
    private withTiming;
    private runCorePasses;
    private runEnrichmentPasses;
    private runAllPasses;
    private finalizeIndex;
    private discoverAndResolve;
    private runIndex;
    private buildIndexProgress;
    index(options: IndexingOptions): Promise<IndexingResult>;
    private pruneDeletedFiles;
    private resolveFilesToProcess;
}
//# sourceMappingURL=indexingPipeline.d.ts.map
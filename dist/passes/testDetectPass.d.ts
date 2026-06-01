/**
 * testDetectPass.ts — Test file detection pass.
 *
 * Identifies test files by common naming conventions (*.test.*, *.spec.*,
 * *_test.*, *_spec.*) and creates TESTS edges between test functions and
 * the production functions they exercise. Uses two complementary heuristics:
 *
 *   1. Name-based: test function name contains the subject function name.
 *   2. Import-based: the test file imports specific functions from the
 *      subject module.
 *
 * Performance: The Function+Method symbol index is cached per-project at
 * module level (FIFO, capped at FUNCTION_INDEX_CACHE_MAX projects). The
 * cache is invalidated when a changed file's QN prefix intersects the
 * cached functionsByName keys, or unconditionally on a full reindex
 * (changedFiles === undefined). Observable via [trace:testDetectPass.cache].
 */
import type { Logger } from '../loggerInterface';
import type { GraphDatabase } from '../graphDatabase';
import type { GraphNode } from '../graphDatabaseTypes';
import type { IndexedFile } from './passTypes';
interface FunctionIndexEntry {
    allFunctions: GraphNode[];
    functionsByName: Map<string, string[]>;
}
declare const _functionIndexCache: Map<string, FunctionIndexEntry>;
export declare function testDetectPass(db: GraphDatabase, projectName: string, indexedFiles: IndexedFile[], changedFiles?: Set<string>, logger?: Logger): void;
export { _functionIndexCache };
//# sourceMappingURL=testDetectPass.d.ts.map
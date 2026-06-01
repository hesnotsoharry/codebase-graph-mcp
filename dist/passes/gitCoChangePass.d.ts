/**
 * gitCoChangePass.ts — Git history co-change analysis pass.
 *
 * Runs `git log --name-only -200` against the project repository and counts
 * how often each pair of files appears together in a single commit. When
 * two files co-change 3+ times, a FILE_CHANGES_WITH edge is created between
 * their corresponding File nodes in the graph.
 *
 * Commits that touch more than 20 files (large refactors, bulk renames) are
 * excluded to avoid noisy correlations.
 */
import type { GraphDatabase } from '../graphDatabase';
/**
 * Fetches and parses git co-change data asynchronously.
 * Must be called before entering a better-sqlite3 transaction.
 * Returns null if git is unavailable or the repo has no commits.
 */
export declare function prefetchGitCoChangeData(projectRoot: string): Promise<string[][] | null>;
/**
 * Inserts FILE_CHANGES_WITH edges using pre-fetched git co-change data.
 * Must run inside a better-sqlite3 transaction.
 * Call prefetchGitCoChangeData() before the transaction and pass the result here.
 */
export declare function gitCoChangePass(db: GraphDatabase, projectName: string, commitFiles: string[][] | null): void;
//# sourceMappingURL=gitCoChangePass.d.ts.map
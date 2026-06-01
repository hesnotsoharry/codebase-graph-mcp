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
import { gitStdout } from '../gitExec.js';
// ─── Configuration ───────────────────────────────────────────────────────────
/** Maximum files per commit before the commit is considered too large. */
const MAX_FILES_PER_COMMIT = 20;
/** Minimum number of co-changes before an edge is created. */
const CO_CHANGE_THRESHOLD = 3;
/** Number of recent commits to analyse. */
const COMMIT_COUNT = 200;
/** Max output buffer for git log (10 MiB). */
const GIT_LOG_MAX_BUFFER = 10 * 1024 * 1024;
// ─── Pre-fetch (async, runs BEFORE the SQLite transaction) ───────────────────
/**
 * Fetches and parses git co-change data asynchronously.
 * Must be called before entering a better-sqlite3 transaction.
 * Returns null if git is unavailable or the repo has no commits.
 */
export async function prefetchGitCoChangeData(projectRoot) {
    try {
        const log = (await gitStdout(projectRoot, ['log', `--pretty=format:---COMMIT---`, '--name-only', `-${COMMIT_COUNT}`], GIT_LOG_MAX_BUFFER)).trim();
        return log
            .split('---COMMIT---')
            .filter(Boolean)
            .map((block) => block.trim().split('\n').filter(Boolean));
    }
    catch {
        return null;
    }
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
function countCoChanges(commitFiles) {
    const coChangeCounts = new Map();
    for (const files of commitFiles) {
        if (files.length < 2 || files.length > MAX_FILES_PER_COMMIT)
            continue;
        for (let i = 0; i < files.length; i++) {
            for (let j = i + 1; j < files.length; j++) {
                // eslint-disable-next-line security/detect-object-injection -- i,j are bounded loop indices
                const key = [files[i], files[j]].sort().join('|');
                coChangeCounts.set(key, (coChangeCounts.get(key) ?? 0) + 1);
            }
        }
    }
    return coChangeCounts;
}
function buildEdges(coChangeCounts, db, projectName) {
    const edges = [];
    coChangeCounts.forEach((count, key) => {
        if (count < CO_CHANGE_THRESHOLD)
            return;
        const [fileA, fileB] = key.split('|');
        const qnA = `${projectName}.${fileA.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
        const qnB = `${projectName}.${fileB.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
        if (!db.getNode(qnA) || !db.getNode(qnB))
            return;
        edges.push({
            project: projectName,
            source_id: qnA,
            target_id: qnB,
            type: 'FILE_CHANGES_WITH',
            props: { count },
        });
    });
    return edges;
}
// ─── Pass implementation ─────────────────────────────────────────────────────
/**
 * Inserts FILE_CHANGES_WITH edges using pre-fetched git co-change data.
 * Must run inside a better-sqlite3 transaction.
 * Call prefetchGitCoChangeData() before the transaction and pass the result here.
 */
export function gitCoChangePass(db, projectName, commitFiles) {
    if (!commitFiles)
        return;
    const coChangeCounts = countCoChanges(commitFiles);
    const edges = buildEdges(coChangeCounts, db, projectName);
    if (edges.length > 0)
        db.insertEdges(edges);
}
//# sourceMappingURL=gitCoChangePass.js.map
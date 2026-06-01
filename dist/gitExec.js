/**
 * gitExec.ts — portable `git` subprocess wrapper for the standalone package.
 *
 * Copied from `src/main/util/gitExec.ts` to avoid any IDE-internal import chain.
 * Pure: only uses `child_process.execFile` and module-level constants.
 * No Electron, no IDE state, no transitive IDE deps.
 */
import { execFile } from 'child_process';
export const GIT_TIMEOUT_MS = 30_000;
export const MB = 1024 * 1024;
export function gitExec(args, opts) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { ...opts, timeout: GIT_TIMEOUT_MS, maxBuffer: opts.maxBuffer ?? MB }, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
    });
}
export async function gitStdout(root, args, maxBuffer = MB) {
    return (await gitExec(args, { cwd: root, maxBuffer })).stdout;
}
//# sourceMappingURL=gitExec.js.map
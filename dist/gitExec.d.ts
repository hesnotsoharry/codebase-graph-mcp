/**
 * gitExec.ts — portable `git` subprocess wrapper for the standalone package.
 *
 * Copied from `src/main/util/gitExec.ts` to avoid any IDE-internal import chain.
 * Pure: only uses `child_process.execFile` and module-level constants.
 * No Electron, no IDE state, no transitive IDE deps.
 */
export declare const GIT_TIMEOUT_MS = 30000;
export declare const MB: number;
export declare function gitExec(args: string[], opts: {
    cwd: string;
    maxBuffer?: number;
}): Promise<{
    stdout: string;
    stderr: string;
}>;
export declare function gitStdout(root: string, args: string[], maxBuffer?: number): Promise<string>;
//# sourceMappingURL=gitExec.d.ts.map
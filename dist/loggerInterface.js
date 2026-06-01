/**
 * loggerInterface.ts — Logger interface for the standalone codebase-graph-mcp package.
 *
 * All classes that previously imported `log from '../logger.js'` (Electron-specific)
 * now accept a `Logger` instance. The default export is `consoleErrorLogger`,
 * which writes structured JSON to console.error (never console.log — stdout is
 * reserved for the MCP stdio protocol and must not be polluted).
 */
function formatArgs(args) {
    if (args.length === 0)
        return '';
    return ' ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
}
/**
 * Default logger implementation — writes structured lines to console.error.
 * console.error writes to stderr; stdout is the MCP protocol channel and must
 * never receive log lines.
 */
export const consoleErrorLogger = {
    info(msg, ...args) {
        console.error(`[INFO] ${msg}${formatArgs(args)}`);
    },
    warn(msg, ...args) {
        console.error(`[WARN] ${msg}${formatArgs(args)}`);
    },
    error(msg, ...args) {
        console.error(`[ERROR] ${msg}${formatArgs(args)}`);
    },
    debug(msg, ...args) {
        console.error(`[DEBUG] ${msg}${formatArgs(args)}`);
    },
};
//# sourceMappingURL=loggerInterface.js.map
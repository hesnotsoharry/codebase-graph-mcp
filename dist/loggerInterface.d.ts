/**
 * loggerInterface.ts — Logger interface for the standalone codebase-graph-mcp package.
 *
 * All classes that previously imported `log from '../logger'` (Electron-specific)
 * now accept a `Logger` instance. The default export is `consoleErrorLogger`,
 * which writes structured JSON to console.error (never console.log — stdout is
 * reserved for the MCP stdio protocol and must not be polluted).
 */
export interface Logger {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
    debug(msg: string, ...args: unknown[]): void;
}
/**
 * Default logger implementation — writes structured lines to console.error.
 * console.error writes to stderr; stdout is the MCP protocol channel and must
 * never receive log lines.
 */
export declare const consoleErrorLogger: Logger;
//# sourceMappingURL=loggerInterface.d.ts.map
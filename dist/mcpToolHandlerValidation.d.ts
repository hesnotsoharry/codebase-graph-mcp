/**
 * mcpToolHandlerValidation.ts — Shared inline validators for MCP tool handlers.
 *
 * Each helper returns the validated value on success, or null + an error string.
 * Errors always start with "Error: " so Claude Code can detect them.
 * No external dependencies; helpers are pure and synchronous.
 */
export type ValidationOk<T> = {
    ok: true;
    value: T;
};
export type ValidationFail = {
    ok: false;
    error: string;
};
export type ValidationResult<T> = ValidationOk<T> | ValidationFail;
/**
 * Validate a required string parameter.
 * Returns ok with the string, or fail if missing or empty.
 */
export declare function assertString(args: Record<string, unknown>, name: string): ValidationResult<string>;
/**
 * Validate an optional enum parameter.
 * If undefined, returns ok with undefined (caller handles default).
 * If present and in allowed, returns ok with the value cast to T.
 * Otherwise fails with a clear error listing allowed values.
 */
export declare function assertOneOf<T extends string>(args: Record<string, unknown>, name: string, allowed: readonly T[]): ValidationResult<T | undefined>;
/**
 * Validate a JSON string parameter.
 * Returns ok with the JSON.parse() result if valid.
 * Returns fail with a clear error otherwise.
 * Used by ingest_traces and similar handlers that accept JSON-encoded data.
 */
export declare function assertJsonString<T = unknown>(args: Record<string, unknown>, name: string): ValidationResult<T>;
//# sourceMappingURL=mcpToolHandlerValidation.d.ts.map
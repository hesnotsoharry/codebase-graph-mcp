/**
 * mcpToolHandlerValidation.ts — Shared inline validators for MCP tool handlers.
 *
 * Each helper returns the validated value on success, or null + an error string.
 * Errors always start with "Error: " so Claude Code can detect them.
 * No external dependencies; helpers are pure and synchronous.
 */
/**
 * Validate a required string parameter.
 * Returns ok with the string, or fail if missing or empty.
 */
export function assertString(args, name) {
    // eslint-disable-next-line security/detect-object-injection -- name comes from handler, not user input
    const value = args[name];
    if (value === undefined || value === null) {
        return { ok: false, error: `Error: missing required parameter '${name}'` };
    }
    if (typeof value !== 'string') {
        return { ok: false, error: `Error: parameter '${name}' must be a string` };
    }
    if (value === '') {
        return { ok: false, error: `Error: parameter '${name}' must not be empty` };
    }
    return { ok: true, value };
}
/**
 * Validate an optional enum parameter.
 * If undefined, returns ok with undefined (caller handles default).
 * If present and in allowed, returns ok with the value cast to T.
 * Otherwise fails with a clear error listing allowed values.
 */
export function assertOneOf(args, name, allowed) {
    // eslint-disable-next-line security/detect-object-injection -- name comes from handler, not user input
    const value = args[name];
    if (value === undefined || value === null) {
        return { ok: true, value: undefined };
    }
    if (typeof value !== 'string') {
        return { ok: false, error: `Error: parameter '${name}' must be one of: ${allowed.join(', ')}` };
    }
    if (allowed.includes(value)) {
        return { ok: true, value: value };
    }
    return { ok: false, error: `Error: parameter '${name}' must be one of: ${allowed.join(', ')}` };
}
/**
 * Validate a JSON string parameter.
 * Returns ok with the JSON.parse() result if valid.
 * Returns fail with a clear error otherwise.
 * Used by ingest_traces and similar handlers that accept JSON-encoded data.
 */
export function assertJsonString(args, name) {
    // eslint-disable-next-line security/detect-object-injection -- name comes from handler, not user input
    const value = args[name];
    if (value === undefined || value === null) {
        return { ok: false, error: `Error: missing required parameter '${name}'` };
    }
    if (typeof value !== 'string') {
        return { ok: false, error: `Error: parameter '${name}' must be a JSON string` };
    }
    try {
        const parsed = JSON.parse(value);
        return { ok: true, value: parsed };
    }
    catch {
        return { ok: false, error: `Error: parameter '${name}' is not valid JSON` };
    }
}
//# sourceMappingURL=mcpToolHandlerValidation.js.map
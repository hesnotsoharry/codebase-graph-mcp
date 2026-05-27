/**
 * mcpToolHandlerValidation.ts — Shared inline validators for MCP tool handlers.
 *
 * Each helper returns the validated value on success, or null + an error string.
 * Errors always start with "Error: " so Claude Code can detect them.
 * No external dependencies; helpers are pure and synchronous.
 */

export type ValidationOk<T> = { ok: true; value: T };
export type ValidationFail = { ok: false; error: string };
export type ValidationResult<T> = ValidationOk<T> | ValidationFail;

/**
 * Validate a required string parameter.
 * Returns ok with the string, or fail if missing or empty.
 */
export function assertString(
  args: Record<string, unknown>,
  name: string,
): ValidationResult<string> {
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
export function assertOneOf<T extends string>(
  args: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): ValidationResult<T | undefined> {
  // eslint-disable-next-line security/detect-object-injection -- name comes from handler, not user input
  const value = args[name];
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: `Error: parameter '${name}' must be one of: ${allowed.join(', ')}` };
  }
  if ((allowed as readonly string[]).includes(value)) {
    return { ok: true, value: value as T };
  }
  return { ok: false, error: `Error: parameter '${name}' must be one of: ${allowed.join(', ')}` };
}

/**
 * Validate a JSON string parameter.
 * Returns ok with the JSON.parse() result if valid.
 * Returns fail with a clear error otherwise.
 * Used by ingest_traces and similar handlers that accept JSON-encoded data.
 */
export function assertJsonString<T = unknown>(
  args: Record<string, unknown>,
  name: string,
): ValidationResult<T> {
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
  } catch {
    return { ok: false, error: `Error: parameter '${name}' is not valid JSON` };
  }
}

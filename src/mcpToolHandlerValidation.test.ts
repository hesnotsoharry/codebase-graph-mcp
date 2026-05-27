/**
 * mcpToolHandlerValidation.test.ts — Tests for inline validation helpers.
 */

import { describe, expect, it } from 'vitest';

import {
  assertJsonString,
  assertOneOf,
  assertString,
} from './mcpToolHandlerValidation';

describe('assertString', () => {
  it('returns ok with the string value when present and non-empty', () => {
    const args = { name: 'hello' };
    const result = assertString(args, 'name');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('hello');
  });

  it('returns fail when the parameter is missing', () => {
    const args = {};
    const result = assertString(args, 'name');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Error: missing required parameter 'name'");
  });

  it('returns fail when the parameter is null', () => {
    const args = { name: null };
    const result = assertString(args, 'name');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Error: missing required parameter 'name'");
  });

  it('returns fail when the parameter is not a string', () => {
    const args = { name: 123 };
    const result = assertString(args, 'name');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Error: parameter 'name' must be a string");
  });

  it('returns fail when the parameter is an empty string', () => {
    const args = { name: '' };
    const result = assertString(args, 'name');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Error: parameter 'name' must not be empty");
  });
});

describe('assertOneOf', () => {
  const allowed = ['inbound', 'outbound', 'both'] as const;

  it('returns ok with undefined when parameter is missing', () => {
    const args = {};
    const result = assertOneOf(args, 'direction', allowed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(undefined);
  });

  it('returns ok with undefined when parameter is null', () => {
    const args = { direction: null };
    const result = assertOneOf(args, 'direction', allowed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(undefined);
  });

  it('returns ok with the value when it is in the allowed set', () => {
    const args = { direction: 'inbound' };
    const result = assertOneOf(args, 'direction', allowed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('inbound');
  });

  it('returns ok with any allowed value', () => {
    for (const val of allowed) {
      const args = { direction: val };
      const result = assertOneOf(args, 'direction', allowed);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(val);
    }
  });

  it('returns fail when the parameter is not in the allowed set', () => {
    const args = { direction: 'invalid' };
    const result = assertOneOf(args, 'direction', allowed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('must be one of: inbound, outbound, both');
    }
  });

  it('returns fail when the parameter is not a string', () => {
    const args = { direction: 123 };
    const result = assertOneOf(args, 'direction', allowed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('must be one of: inbound, outbound, both');
    }
  });
});

describe('assertJsonString', () => {
  it('returns ok with the parsed JSON when the parameter is valid JSON', () => {
    const args = { data: '{"key":"value"}' };
    const result = assertJsonString(args, 'data');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ key: 'value' });
  });

  it('returns ok with an array when the parameter is a JSON array', () => {
    const args = { data: '[1,2,3]' };
    const result = assertJsonString(args, 'data');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([1, 2, 3]);
  });

  it('returns fail when the parameter is missing', () => {
    const args = {};
    const result = assertJsonString(args, 'data');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Error: missing required parameter 'data'");
  });

  it('returns fail when the parameter is null', () => {
    const args = { data: null };
    const result = assertJsonString(args, 'data');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Error: missing required parameter 'data'");
  });

  it('returns fail when the parameter is not a string', () => {
    const args = { data: { key: 'value' } };
    const result = assertJsonString(args, 'data');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Error: parameter 'data' must be a JSON string");
  });

  it('returns fail when the parameter is not valid JSON', () => {
    const args = { data: '{invalid json}' };
    const result = assertJsonString(args, 'data');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Error: parameter 'data' is not valid JSON");
  });

  it('returns fail when the parameter is an empty string', () => {
    const args = { data: '' };
    const result = assertJsonString(args, 'data');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Error: parameter 'data' is not valid JSON");
  });
});

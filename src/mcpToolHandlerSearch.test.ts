/**
 * Smoke tests for the Wave 66 search helpers — 3-tier ranked path and
 * filtered fallback.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GraphDatabase } from './graphDatabase';
import type { GraphToolContext } from './mcpToolHandlers';
import { hasOnlyQuery, runFilteredSearch, runRankedSearch } from './mcpToolHandlerSearch';

function makeCtx(db: GraphDatabase): GraphToolContext {
  return {
    db,
    projectName: 'test-search',
    projectRoot: '/tmp',
    queryEngine: {} as never,
    cypherEngine: {} as never,
    pipeline: {} as never,
  };
}

describe('hasOnlyQuery', () => {
  it('returns true when only query is set', () => {
    expect(hasOnlyQuery({ query: 'foo' })).toBe(true);
    expect(hasOnlyQuery({ query: 'foo', limit: 10 })).toBe(true);
  });
  it('returns false when any filter arg is set', () => {
    expect(hasOnlyQuery({ query: 'foo', label: 'Function' })).toBe(false);
    expect(hasOnlyQuery({ query: 'foo', project: 'other' })).toBe(false);
    expect(hasOnlyQuery({ query: 'foo', offset: 10 })).toBe(false);
  });
});

describe('3-tier ranked search', () => {
  let db: GraphDatabase;
  beforeAll(() => {
    db = new GraphDatabase(':memory:');
    db.upsertProject({
      name: 'test-search',
      root_path: '/tmp',
      indexed_at: 0,
      node_count: 0,
      edge_count: 0,
    });
    db.insertNodes([
      {
        id: 'test-search.searchGraph',
        project: 'test-search',
        label: 'Function',
        name: 'searchGraph',
        qualified_name: 'test-search.searchGraph',
        file_path: 'a.ts',
        start_line: 1,
        end_line: 5,
        props: {},
      },
      {
        id: 'test-search.searchGraphInternal',
        project: 'test-search',
        label: 'Function',
        name: 'searchGraphInternal',
        qualified_name: 'test-search.searchGraphInternal',
        file_path: 'b.ts',
        start_line: 1,
        end_line: 5,
        props: {},
      },
      {
        id: 'test-search.compatSearchGraph',
        project: 'test-search',
        label: 'Function',
        name: 'compatSearchGraph',
        qualified_name: 'test-search.compatSearchGraph',
        file_path: 'c.ts',
        start_line: 1,
        end_line: 5,
        props: {},
      },
    ]);
  });
  afterAll(() => db.close());

  it('returns three tiers in rank order: exact, prefix, substring', () => {
    const result = runRankedSearch(makeCtx(db), 'searchGraph', 100);
    expect(result).toContain('Exact matches:');
    expect(result).toContain('Prefix matches:');
    expect(result).toContain('Substring matches:');
    // Order: exact appears before prefix, prefix appears before substring
    const exactIdx = result.indexOf('Exact matches:');
    const prefixIdx = result.indexOf('Prefix matches:');
    const subIdx = result.indexOf('Substring matches:');
    expect(exactIdx).toBeLessThan(prefixIdx);
    expect(prefixIdx).toBeLessThan(subIdx);
    // All three nodes present
    expect(result).toContain('searchGraph');
    expect(result).toContain('searchGraphInternal');
    expect(result).toContain('compatSearchGraph');
  });

  it('returns "No matching nodes found." when nothing matches', () => {
    const result = runRankedSearch(makeCtx(db), 'nonexistentSymbolXYZ', 100);
    expect(result).toBe('No matching nodes found.');
  });
});

describe('filtered search fallback', () => {
  let db: GraphDatabase;
  beforeAll(() => {
    db = new GraphDatabase(':memory:');
    db.upsertProject({
      name: 'test-search',
      root_path: '/tmp',
      indexed_at: 0,
      node_count: 0,
      edge_count: 0,
    });
    db.insertNodes([
      {
        id: 'test-search.helper',
        project: 'test-search',
        label: 'Function',
        name: 'helper',
        qualified_name: 'test-search.helper',
        file_path: 'a.ts',
        start_line: 1,
        end_line: 5,
        props: {},
      },
    ]);
  });
  afterAll(() => db.close());

  it('uses filtered path when label filter is supplied', () => {
    const result = runFilteredSearch({ label: 'Function', limit: 10 }, makeCtx(db), 'helper');
    expect(result).toContain('Found 1 nodes');
    expect(result).toContain('helper');
  });
});

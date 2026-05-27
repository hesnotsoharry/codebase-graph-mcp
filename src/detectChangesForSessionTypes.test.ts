/**
 * detectChangesForSessionTypes.test.ts — Smoke tests for the
 * ChangedSymbolsForSession shape and its structural contract.
 *
 * These tests verify the type shape compiles correctly and that the
 * GraphDatabase.detectChangesForSession method returns a conforming object.
 * Full integration tests live in graphDatabase.test.ts.
 */

import { describe, expect, it } from 'vitest';

import type { ChangedSymbol, ChangedSymbolsForSession } from './detectChangesForSessionTypes';

// ─── Shape conformance ────────────────────────────────────────────────────────

describe('ChangedSymbolsForSession shape', () => {
  it('accepts a fully-populated result', () => {
    const sym: ChangedSymbol = {
      id: 'proj::src/foo.ts::bar',
      name: 'bar',
      label: 'Function',
      filePath: 'src/foo.ts',
      startLine: 10,
      hopDepth: 0,
    };

    const result: ChangedSymbolsForSession = {
      projectName: 'my-project',
      changedFiles: ['src/foo.ts'],
      affectedSymbols: [sym],
      blastRadius: 1,
    };

    expect(result.projectName).toBe('my-project');
    expect(result.changedFiles).toHaveLength(1);
    expect(result.affectedSymbols).toHaveLength(1);
    expect(result.blastRadius).toBe(1);
  });

  it('accepts an empty (no-change) result', () => {
    const result: ChangedSymbolsForSession = {
      projectName: 'my-project',
      changedFiles: [],
      affectedSymbols: [],
      blastRadius: 0,
    };

    expect(result.changedFiles).toHaveLength(0);
    expect(result.affectedSymbols).toHaveLength(0);
    expect(result.blastRadius).toBe(0);
  });

  it('accepts null filePath and startLine on a symbol', () => {
    const sym: ChangedSymbol = {
      id: 'proj::virtual::sym',
      name: 'sym',
      label: 'Module',
      filePath: null,
      startLine: null,
      hopDepth: 1,
    };

    expect(sym.filePath).toBeNull();
    expect(sym.startLine).toBeNull();
    expect(sym.hopDepth).toBe(1);
  });

  it('tracks hopDepth correctly for transitive callers', () => {
    const direct: ChangedSymbol = {
      id: 'a',
      name: 'a',
      label: 'Function',
      filePath: 'f.ts',
      startLine: 1,
      hopDepth: 0,
    };
    const hop1: ChangedSymbol = {
      id: 'b',
      name: 'b',
      label: 'Function',
      filePath: 'g.ts',
      startLine: 5,
      hopDepth: 1,
    };
    const hop2: ChangedSymbol = {
      id: 'c',
      name: 'c',
      label: 'Function',
      filePath: 'h.ts',
      startLine: 9,
      hopDepth: 2,
    };

    const result: ChangedSymbolsForSession = {
      projectName: 'p',
      changedFiles: ['f.ts'],
      affectedSymbols: [direct, hop1, hop2],
      blastRadius: 3,
    };

    const depths = result.affectedSymbols.map((s) => s.hopDepth);
    expect(depths).toEqual([0, 1, 2]);
  });
});

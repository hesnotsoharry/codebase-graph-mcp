/**
 * treeSitterParser.integration.test.ts — Wave 93 Phase C acceptance test.
 *
 * Orchestrator-authored boundary contract test (per
 * ~/.claude/rules/orchestrator-owned-acceptance-tests.md). The subagent
 * implementing the web-tree-sitter bump MAY NOT modify this file.
 *
 * Contract being tested: web-tree-sitter MUST be able to load the
 * @vscode/tree-sitter-wasm@0.3.1 grammar files (ABI 15) for javascript and
 * python without throwing "Incompatible language version" during
 * Parser.prototype.setLanguage.
 *
 * Pre-bump (web-tree-sitter@0.22.6): expected to FAIL — that release supports
 *   ABI 13-14 only, and setLanguage throws when given an ABI 15 language.
 * Post-bump (web-tree-sitter@^0.26.8): expected to PASS — ABI 15 support
 *   landed in 0.25.0.
 *
 * The IDE's existing TreeSitterParser silently falls back from @vscode wasms
 * to the older tree-sitter-wasms@0.1.13 (ABI 13/14 compatible) grammars when
 * setLanguage throws, so the high-level parseFile path continues to work.
 * This test bypasses the fallback to assert the ACTUAL contract: vendor SDK
 * compatibility with the vendor's current grammar artifacts.
 *
 * Note on import shape: web-tree-sitter 0.25+ rewrote the package with named
 * ESM exports (Parser and Language are now separate top-level classes); the
 * pre-0.25 default-export shape (Parser with Parser.Language) is gone.
 */

import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Language, Parser } from 'web-tree-sitter';

function resolveVscodeGrammarDir(): string {
  const pkgPath = require.resolve('@vscode/tree-sitter-wasm/package.json');
  return path.join(path.dirname(pkgPath), 'wasm');
}

describe('treeSitterParser — @vscode/tree-sitter-wasm ABI 15 compatibility (Wave 93 Phase C)', () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it('loads javascript (ABI 15) and parses a trivial program without ABI mismatch', async () => {
    const wasmPath = path.join(resolveVscodeGrammarDir(), 'tree-sitter-javascript.wasm');
    const parser = new Parser();
    const lang = await Language.load(wasmPath);

    expect(() => parser.setLanguage(lang)).not.toThrow();

    const tree = parser.parse('const x = 1;');
    expect(tree).not.toBeNull();
    expect(tree?.rootNode.type).toBe('program');

    parser.delete();
  });

  it('loads python (ABI 15) and parses a trivial program without ABI mismatch', async () => {
    const wasmPath = path.join(resolveVscodeGrammarDir(), 'tree-sitter-python.wasm');
    const parser = new Parser();
    const lang = await Language.load(wasmPath);

    expect(() => parser.setLanguage(lang)).not.toThrow();

    const tree = parser.parse('x = 1\n');
    expect(tree).not.toBeNull();
    expect(tree?.rootNode.type).toBe('module');

    parser.delete();
  });
});

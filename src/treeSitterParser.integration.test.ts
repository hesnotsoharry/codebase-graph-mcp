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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Language, Parser } from 'web-tree-sitter';

import { TreeSitterParser } from './treeSitterParser';

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

// ─── hasParseError end-to-end contract ───────────────────────────────────────
//
// These tests exercise the full TreeSitterParser.parseFile() → WASM parse →
// tree.rootNode.hasError → ParsedFileResult.hasParseError path with REAL input.
// They are the load-bearing regression guard for the parse-anomaly rework:
// if hasError silently returns false on broken input, this suite catches it
// before the fixture-only unit tests ever run.

describe('TreeSitterParser.parseFile — hasParseError via live WASM parser', () => {
  let parser: TreeSitterParser;

  beforeAll(async () => {
    parser = new TreeSitterParser();
    await parser.init();
  });

  afterAll(() => {
    parser.dispose();
  });

  it('sets hasParseError:true and a non-null firstErrorLine for a syntactically broken TypeScript file', async () => {
    // Deliberately broken: function keyword followed by two sets of unclosed
    // parentheses/braces — reliably yields ERROR/MISSING nodes in the TS grammar.
    const brokenSource = 'function ((({\n  const x = ;\n}\n';

    const result = await parser.parseFile('broken.ts', brokenSource);

    expect(result).not.toBeNull();
    expect(result!.hasParseError).toBe(true);
    expect(result!.firstErrorLine).not.toBeNull();
    expect(typeof result!.firstErrorLine).toBe('number');
    expect(result!.firstErrorLine).toBeGreaterThanOrEqual(1);
  });

  it('sets hasParseError:false and firstErrorLine:null for a well-formed TypeScript file', async () => {
    // Clean single-declaration module — tree-sitter parses this without any
    // ERROR or MISSING nodes.
    const cleanSource = 'export const x = 1;\n';

    const result = await parser.parseFile('clean.ts', cleanSource);

    expect(result).not.toBeNull();
    expect(result!.hasParseError).toBe(false);
    expect(result!.firstErrorLine).toBeNull();
  });

  it('sets hasParseError:false for a shebang .mjs file (shebang is a valid hash_bang_line node, not an error)', async () => {
    // Service / hook scripts often start with a shebang. Confirm the grammar
    // treats hash_bang_line as a valid program child, not an ERROR node.
    const shebangSource = '#!/usr/bin/env node\nimport fs from "fs";\nconsole.log(fs.readdirSync("."));\n';

    const result = await parser.parseFile('hook.mjs', shebangSource);

    expect(result).not.toBeNull();
    expect(result!.hasParseError).toBe(false);
    expect(result!.firstErrorLine).toBeNull();
  });
});

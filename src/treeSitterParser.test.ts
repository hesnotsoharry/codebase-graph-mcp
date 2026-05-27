/**
 * treeSitterParser.test.ts — Wave 67 regression coverage.
 *
 * The companion fixture at `__fixtures__/modernTs.ts` exercises modern
 * TypeScript syntactic constructs that have historically caused parse-output
 * drift across grammar versions: inline-type imports, satisfies, using,
 * decorators, abstract classes, namespaces, ambient declarations, and const
 * type parameters. This test asserts the IDE's TreeSitterParser extracts the
 * expected top-level definitions; failure indicates a grammar upgrade or
 * pipeline change has silently regressed one of these features.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { TreeSitterParser } from './treeSitterParser';

describe('TreeSitterParser — modernTs.ts regression fixture (Wave 67)', () => {
  it('extracts the expected top-level definitions and method members', async () => {
    const parser = new TreeSitterParser();
    await parser.init();
    const fixturePath = path.join(__dirname, '__fixtures__', 'modernTs.ts');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixturePath is a constant under __dirname
    const content = fs.readFileSync(fixturePath, 'utf-8');
    const result = await parser.parseFile('modernTs.ts', content);

    expect(result).not.toBeNull();
    if (!result) return;

    const byKind = new Map<string, string[]>();
    for (const def of result.definitions) {
      const list = byKind.get(def.kind) ?? [];
      list.push(def.name);
      byKind.set(def.kind, list);
    }

    // Classes: abstract + full + decorated + auto-accessor. Order may vary; assert membership.
    // AutoAccessorClass exercises the TS 5.0 `accessor` keyword — if the grammar
    // doesn't recognize it as a class-member modifier, this assertion catches the regression.
    // See roadmap/deferred/tree-sitter-grammar-upgrade.md.
    expect(byKind.get('Class')).toEqual(
      expect.arrayContaining(['AbstractWidget', 'FullClass', 'DecoratedClass', 'AutoAccessorClass']),
    );

    // Function: top-level decorator helper + generic with const T.
    expect(byKind.get('Function')).toEqual(expect.arrayContaining(['decorator', 'pick']));

    // Methods: at least one from each class. exact-match-irrelevant; assert count >= 4.
    expect((byKind.get('Method') ?? []).length).toBeGreaterThanOrEqual(4);

    // Total: at least 10 definitions (4 classes + 2 functions + 4 methods minimum).
    expect(result.definitions.length).toBeGreaterThanOrEqual(10);
  });
});

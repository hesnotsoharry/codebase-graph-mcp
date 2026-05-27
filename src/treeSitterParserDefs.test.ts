/**
 * treeSitterParserDefs.test.ts — Unit tests for class_heritage extraction.
 *
 * Wave 21 Phase 1: verifies that `extractSingleDefinition` correctly populates
 * `implements` and `extendsClause` on ExtractedDefinition for TS class nodes.
 *
 * Tests exercise the real tree-sitter parser (WASM) — the subject is the
 * extraction logic in `treeSitterParserDefs.ts`. Assertions are on the
 * `definitions` array returned from `TreeSitterParser.parseFile`.
 *
 * Four heritage shapes covered per the Wave 21 phase spec:
 *   1. Class with no heritage — fields undefined/null.
 *   2. Class with `extends Base` only — extendsClause='Base', implements undefined.
 *   3. Class with `implements IA` only — extendsClause=null, implements=['IA'].
 *   4. Class with `extends Base implements IA, IB` — both populated.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TreeSitterParser } from './treeSitterParser';

// ─── Shared parser instance ───────────────────────────────────────────────────

let parser: TreeSitterParser;

beforeAll(async () => {
  parser = new TreeSitterParser();
  await parser.init();
}, 30_000);

afterAll(() => {
  // TreeSitterParser has no close(); WASM state is process-scoped.
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function parseSource(src: string) {
  const result = await parser.parseFile('fixture.ts', src);
  if (!result) throw new Error('parseFile returned null unexpectedly');
  return result;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('class_heritage extraction — no heritage', () => {
  it('class with no heritage emits undefined implements and null extendsClause', async () => {
    const result = await parseSource(`
export class Plain {
  method(): void {}
}
`);
    const classDef = result.definitions.find((d) => d.name === 'Plain' && d.kind === 'Class');
    expect(classDef).toBeDefined();
    expect(classDef!.implements).toBeUndefined();
    // extendsClause is null (no extends) — the field is set because kind === 'Class'
    expect(classDef!.extendsClause).toBeNull();
  });
});

describe('class_heritage extraction — extends only', () => {
  it('class with extends Base populates extendsClause and leaves implements undefined', async () => {
    const result = await parseSource(`
export class Base {}
export class Child extends Base {}
`);
    const childDef = result.definitions.find((d) => d.name === 'Child' && d.kind === 'Class');
    expect(childDef).toBeDefined();
    expect(childDef!.extendsClause).toBe('Base');
    expect(childDef!.implements).toBeUndefined();
  });
});

describe('class_heritage extraction — implements only', () => {
  it('class with implements IA populates implements array and sets extendsClause to null', async () => {
    const result = await parseSource(`
export interface IA { doA(): void; }
export class Impl implements IA {
  doA(): void {}
}
`);
    const implDef = result.definitions.find((d) => d.name === 'Impl' && d.kind === 'Class');
    expect(implDef).toBeDefined();
    expect(implDef!.extendsClause).toBeNull();
    expect(implDef!.implements).toEqual(['IA']);
  });
});

describe('class_heritage extraction — extends and multiple implements', () => {
  it('class with extends Base implements IA, IB populates both fields correctly', async () => {
    const result = await parseSource(`
export interface IA { doA(): void; }
export interface IB { doB(): number; }
export class Base {}
export class Full extends Base implements IA, IB {
  doA(): void {}
  doB(): number { return 0; }
}
`);
    const fullDef = result.definitions.find((d) => d.name === 'Full' && d.kind === 'Class');
    expect(fullDef).toBeDefined();
    expect(fullDef!.extendsClause).toBe('Base');
    expect(fullDef!.implements).toEqual(expect.arrayContaining(['IA', 'IB']));
    expect(fullDef!.implements).toHaveLength(2);
  });
});

describe('class_heritage extraction — regression: non-Class kinds unaffected', () => {
  it('Function definitions have undefined implements and extendsClause', async () => {
    const result = await parseSource(`
export function standaloneHelper(): void {}
`);
    const fnDef = result.definitions.find((d) => d.name === 'standaloneHelper' && d.kind === 'Function');
    expect(fnDef).toBeDefined();
    // Non-class: extendsClause should be undefined (not set)
    expect(fnDef!.extendsClause).toBeUndefined();
    expect(fnDef!.implements).toBeUndefined();
  });

  it('Interface definitions have undefined implements and extendsClause', async () => {
    const result = await parseSource(`
export interface IFoo { foo(): void; }
`);
    const ifaceDef = result.definitions.find((d) => d.name === 'IFoo' && d.kind === 'Interface');
    expect(ifaceDef).toBeDefined();
    expect(ifaceDef!.extendsClause).toBeUndefined();
    expect(ifaceDef!.implements).toBeUndefined();
  });
});

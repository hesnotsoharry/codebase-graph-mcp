/**
 * treeSitterTestExtractor.test.ts — Tests for extractTestCaseDefinitions.
 *
 * Test seam: real TreeSitterParser (WASM-backed). We parse inline TypeScript
 * source strings and assert on the `definitions` array, specifically on entries
 * with `kind === 'Test'`. This exercises the real extraction logic without mocking
 * the subject under test.
 *
 * Contracts verified:
 *   1. describe>it nesting → Test nodes with chain-prefixed names.
 *   2. Nested describes build the full QN chain (Outer>Inner>name).
 *   3. it(dynamicVar, ...) is skipped (first arg is not a string literal).
 *   4. describe() emits a structural Test node; it() emits a leaf Test node.
 *   5. it.only and xit are recognized as leaf tests.
 *   6. '>' in description string is sanitized to '-' in the emitted name.
 *   7. A test file with no describe/it emits zero Test nodes.
 *   8. testDetectPass accepts kind === 'Test' definitions to build TESTS edges.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LEAF_TEST_GLOBALS, STRUCTURAL_TEST_GLOBALS } from './treeSitterTestExtractor';
import { TreeSitterParser } from './treeSitterParser';

// ─── Shared parser instance ───────────────────────────────────────────────────

let parser: TreeSitterParser;

beforeAll(async () => {
  parser = new TreeSitterParser();
  await parser.init();
}, 30_000);

afterAll(() => {
  // TreeSitterParser has no explicit close; WASM state is process-scoped.
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Parse an inline TypeScript snippet and return all Test-kind definitions. */
async function parseTestDefs(src: string) {
  // Use a .test.ts filename so it looks like a test file; the extractor itself
  // is gated on TS_JS_LANGUAGES (config.id check), not the filename pattern.
  const result = await parser.parseFile('fixture.test.ts', src);
  if (!result) throw new Error('parseFile returned null — grammar may not be loaded');
  return result.definitions.filter((d) => d.kind === 'Test');
}

// ─── Contract 1: describe>it → chain-prefixed names ──────────────────────────

describe('extractTestCaseDefinitions — describe>it produces Test nodes with chain-prefixed names', () => {
  it('emits two Test nodes for a simple describe+it structure', async () => {
    const src = `
describe('UserService', () => {
  it('creates a user', () => {});
});
`;
    const tests = await parseTestDefs(src);
    // Should emit: 'UserService' (structural) and 'UserService>creates a user' (leaf).
    expect(tests.length).toBe(2);
  });

  it('emits the describe node with its bare name', async () => {
    const src = `
describe('UserService', () => {
  it('creates a user', () => {});
});
`;
    const tests = await parseTestDefs(src);
    const structuralNode = tests.find((t) => t.name === 'UserService');
    expect(structuralNode).toBeDefined();
    expect(structuralNode?.kind).toBe('Test');
  });

  it('emits the leaf it node with full chain-prefixed name', async () => {
    const src = `
describe('UserService', () => {
  it('creates a user', () => {});
});
`;
    const tests = await parseTestDefs(src);
    const leafNode = tests.find((t) => t.name === 'UserService>creates a user');
    expect(leafNode).toBeDefined();
    expect(leafNode?.kind).toBe('Test');
  });

  it('emits isExported: false for all Test nodes', async () => {
    const src = `
describe('Suite', () => {
  it('does something', () => {});
});
`;
    const tests = await parseTestDefs(src);
    for (const t of tests) {
      expect(t.isExported).toBe(false);
    }
  });
});

// ─── Contract 2: nested describes build the full QN chain ────────────────────

describe('extractTestCaseDefinitions — nested describes accumulate the full chain', () => {
  it('three-level nesting: Outer>Inner>leaf emits correct name on the leaf', async () => {
    const src = `
describe('Outer', () => {
  describe('Inner', () => {
    it('the leaf', () => {});
  });
});
`;
    const tests = await parseTestDefs(src);
    const leaf = tests.find((t) => t.name === 'Outer>Inner>the leaf');
    expect(leaf).toBeDefined();
    expect(leaf?.kind).toBe('Test');
  });

  it('two top-level describes each produce their own namespace', async () => {
    const src = `
describe('A', () => {
  it('passes', () => {});
});
describe('B', () => {
  it('passes', () => {});
});
`;
    const tests = await parseTestDefs(src);
    const names = tests.map((t) => t.name);
    expect(names).toContain('A>passes');
    expect(names).toContain('B>passes');
  });
});

// ─── Contract 3: dynamic first arg is skipped ─────────────────────────────────

describe('extractTestCaseDefinitions — non-string first arg skipped gracefully', () => {
  it('emits nothing when the first argument to it() is an identifier (dynamic)', async () => {
    const src = `
const msg = 'dynamic';
it(msg, () => {});
`;
    const tests = await parseTestDefs(src);
    // The `it(msg, ...)` call has an identifier as first arg — must be skipped.
    // (There is no describe wrapping it, so no structural node either.)
    expect(tests.length).toBe(0);
  });

  it('emits nothing when the first argument to describe() is a template literal', async () => {
    const src = `
const name = 'X';
describe(\`suite \${name}\`, () => {
  it('case', () => {});
});
`;
    const tests = await parseTestDefs(src);
    // describe has a template_string first arg → skipped.
    // The 'it' has no enclosing describe chain (the describe was skipped), but
    // the it('case', ...) itself has a plain string — it SHOULD emit 'case'.
    // The describe chain walk finds no structural ancestor with a string label.
    const itNode = tests.find((t) => t.name === 'case');
    expect(itNode).toBeDefined();
    // And no structural (describe) node was emitted.
    expect(tests.filter((t) => t.name.includes('suite'))).toHaveLength(0);
  });
});

// ─── Contract 4: structural vs leaf classification ────────────────────────────

describe('extractTestCaseDefinitions — LEAF_TEST_GLOBALS and STRUCTURAL_TEST_GLOBALS sets', () => {
  it('LEAF_TEST_GLOBALS includes it, test, xit, xtest, fit, ftest, it.only, test.only, it.skip, test.skip', () => {
    expect(LEAF_TEST_GLOBALS.has('it')).toBe(true);
    expect(LEAF_TEST_GLOBALS.has('test')).toBe(true);
    expect(LEAF_TEST_GLOBALS.has('xit')).toBe(true);
    expect(LEAF_TEST_GLOBALS.has('xtest')).toBe(true);
    expect(LEAF_TEST_GLOBALS.has('fit')).toBe(true);
    expect(LEAF_TEST_GLOBALS.has('ftest')).toBe(true);
    expect(LEAF_TEST_GLOBALS.has('it.only')).toBe(true);
    expect(LEAF_TEST_GLOBALS.has('test.only')).toBe(true);
    expect(LEAF_TEST_GLOBALS.has('it.skip')).toBe(true);
    expect(LEAF_TEST_GLOBALS.has('test.skip')).toBe(true);
  });

  it('STRUCTURAL_TEST_GLOBALS includes describe, describe.only, describe.skip, xdescribe, fdescribe, suite, context', () => {
    expect(STRUCTURAL_TEST_GLOBALS.has('describe')).toBe(true);
    expect(STRUCTURAL_TEST_GLOBALS.has('describe.only')).toBe(true);
    expect(STRUCTURAL_TEST_GLOBALS.has('describe.skip')).toBe(true);
    expect(STRUCTURAL_TEST_GLOBALS.has('xdescribe')).toBe(true);
    expect(STRUCTURAL_TEST_GLOBALS.has('fdescribe')).toBe(true);
    expect(STRUCTURAL_TEST_GLOBALS.has('suite')).toBe(true);
    expect(STRUCTURAL_TEST_GLOBALS.has('context')).toBe(true);
  });

  it('describe() is not in LEAF_TEST_GLOBALS', () => {
    expect(LEAF_TEST_GLOBALS.has('describe')).toBe(false);
  });

  it('it() is not in STRUCTURAL_TEST_GLOBALS', () => {
    expect(STRUCTURAL_TEST_GLOBALS.has('it')).toBe(false);
  });
});

// ─── Contract 5: it.only and xit are recognized ───────────────────────────────

describe('extractTestCaseDefinitions — it.only and xit are recognized as leaf tests', () => {
  it('it.only emits a Test node with kind Test', async () => {
    const src = `
it.only('the only case', () => {});
`;
    const tests = await parseTestDefs(src);
    const node = tests.find((t) => t.name === 'the only case');
    expect(node).toBeDefined();
    expect(node?.kind).toBe('Test');
  });

  it('xit emits a Test node (skipped-test marker)', async () => {
    const src = `
xit('skipped case', () => {});
`;
    const tests = await parseTestDefs(src);
    const node = tests.find((t) => t.name === 'skipped case');
    expect(node).toBeDefined();
    expect(node?.kind).toBe('Test');
  });

  it('test.skip emits a Test node', async () => {
    const src = `
test.skip('a skipped test', () => {});
`;
    const tests = await parseTestDefs(src);
    const node = tests.find((t) => t.name === 'a skipped test');
    expect(node).toBeDefined();
    expect(node?.kind).toBe('Test');
  });
});

// ─── Contract 6: '>' in description is sanitized to '-' ──────────────────────

describe("extractTestCaseDefinitions — '>' in description is sanitized to '-'", () => {
  it("replaces '>' with '-' in a bare it() description", async () => {
    const src = `
it('a > b comparison', () => {});
`;
    const tests = await parseTestDefs(src);
    // '>' must be replaced with '-' so the QN separator stays unambiguous.
    const node = tests.find((t) => t.name === 'a - b comparison');
    expect(node).toBeDefined();
  });

  it("replaces '>' with '-' in a describe() that is part of a nested chain", async () => {
    const src = `
describe('compare > values', () => {
  it('returns true', () => {});
});
`;
    const tests = await parseTestDefs(src);
    // The describe node itself uses the sanitized name.
    const describeNode = tests.find((t) => t.name === 'compare - values');
    expect(describeNode).toBeDefined();
    // The leaf chain-prefixes with the sanitized describe name.
    const leafNode = tests.find((t) => t.name === 'compare - values>returns true');
    expect(leafNode).toBeDefined();
  });
});

// ─── Contract 7: source file with no test calls → zero Test nodes ─────────────

describe('extractTestCaseDefinitions — source file with no test calls emits zero Test nodes', () => {
  it('plain production TypeScript file emits no Test nodes', async () => {
    const src = `
export function add(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  multiply(a: number, b: number): number { return a * b; }
}
`;
    const tests = await parseTestDefs(src);
    expect(tests.length).toBe(0);
  });
});

// ─── Contract 8: testDetectPass accepts kind === 'Test' ───────────────────────

describe('testDetectPass — kind Test definitions produce TESTS edges (integration)', () => {
  it('emits a TESTS edge when a Test-kind definition name matches a production function', async () => {
    const { testDetectPass, _functionIndexCache } = await import('./passes/testDetectPass');
    const { vi } = await import('vitest');

    // Reset module-level cache.
    _functionIndexCache.clear();

    // Production function node with name 'createUser'.
    const fnNode = {
      id: 'proj.src.userService.createUser',
      project: 'proj',
      label: 'Function' as const,
      name: 'createUser',
      qualified_name: 'proj.src.userService.createUser',
      file_path: 'src/userService.ts',
      start_line: 1,
      end_line: 5,
      props: {},
    };

    const db = {
      getNodesByLabel: vi.fn().mockReturnValue([fnNode]),
      insertEdges: vi.fn(),
      transaction: vi.fn((fn: () => void) => fn()),
    };

    // A test file with a Test-kind definition whose name contains 'createUser'.
    const testFile = {
      relativePath: 'src/userService.test.ts',
      parsed: {
        filePath: 'src/userService.test.ts',
        language: 'typescript',
        lineCount: 10,
        definitions: [
          {
            kind: 'Test' as never,
            name: 'UserService>createUser returns the new user',
            startLine: 3,
            endLine: 5,
            isExported: false,
            isDefault: false,
            isAsync: false,
            isStatic: false,
            isAbstract: false,
            decorators: [],
            receiver: null,
            constants: [],
            signature: null,
            returnType: null,
          },
        ],
        imports: [],
        calls: [],
        routes: [],
        exportedNames: [],
      },
    };

    testDetectPass(db as never, 'proj', [testFile], undefined);

    // The Test-kind definition name contains 'createuser' (case-insensitive)
    // which matches the production function name 'createUser' → edge emitted.
    expect(db.insertEdges).toHaveBeenCalled();
    const edges: Array<{ source_id: string; target_id: string; type: string }> =
      db.insertEdges.mock.calls[0][0];
    expect(edges.length).toBeGreaterThanOrEqual(1);
    const testsEdge = edges.find((e) => e.type === 'TESTS');
    expect(testsEdge).toBeDefined();
    expect(testsEdge?.target_id).toBe('proj.src.userService.createUser');
  });
});

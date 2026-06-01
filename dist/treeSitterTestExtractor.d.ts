/**
 * treeSitterTestExtractor.ts — Extracts test-case definitions from test files.
 *
 * Test frameworks write test cases as call-expression arguments:
 *   describe('suite', () => { it('case', () => { ... }) })
 *
 * The main `extractArrowFunctions` pass only handles top-level `const fn = () =>`
 * declarations, so test callbacks are never captured. This module provides
 * `extractTestCaseDefinitions`, which walks every `call_expression` in the AST
 * and emits `ExtractedDefinition` entries with `kind: 'Test'` for matching globals.
 *
 * --- Describe-stack strategy ---
 * `walkTree` in `treeSitterParser.ts` is an ENTER-ONLY iterative stack walk
 * (no exit hook). Rather than trying to push/pop a describe-stack during the walk,
 * we derive the enclosing describe chain for each matched `call_expression` by
 * walking UP via `node.parent` pointers. This ancestor-walk is O(depth) per node,
 * where depth is typically ≤ 5 in real test files — acceptable.
 *
 * --- QN separator ---
 * The qualified-name separator between describe levels is `>`. If a description
 * string itself contains `>`, we replace it with `-` before building the QN so
 * the separator stays unambiguous.
 *
 * --- Emitted `def.name` ---
 * For leaf test nodes (`it`, `test`, etc.), `def.name` is the full describe-chain
 * prefixed string: `Outer>Inner>test description`. This is the value that
 * `testDetectPass.buildTestFunctionEdges` appends to the file QN to form the TESTS
 * edge source_id, and also runs through the name-heuristic as-is. For structural
 * nodes (`describe`), `def.name` is similarly chain-prefixed so QNs are unique
 * within a file.
 */
import type { Node } from 'web-tree-sitter';
import type { ExtractedDefinition } from './treeSitterTypes';
/**
 * Leaf test globals: emit Test nodes AND are valid TESTS-edge sources.
 * These map to individual test cases that actually exercise production code.
 */
export declare const LEAF_TEST_GLOBALS: Set<string>;
/**
 * Structural test globals: emit Test nodes for name-scoping only.
 * These are NOT TESTS-edge sources — they organize test cases but don't
 * exercise production code directly.
 *
 * `it.each` and `test.each` are treated as STRUCTURAL here to avoid the
 * complexity of table-driven `it.each(table)(name, fn)` callee extraction.
 * TODO(v0.3): table-driven it.each / test.each name extraction.
 */
export declare const STRUCTURAL_TEST_GLOBALS: Set<string>;
/**
 * Extract test-case definitions from the AST and push them into `definitions`.
 *
 * Mutates the `definitions` array in place — same pattern as `extractArrowFunctions`
 * in `treeSitterParser.ts`.
 *
 * Only called for TS/JS language configs (gated in `extractDefinitions`).
 *
 * Walk strategy: independent iterative traversal of the AST. The cost is one
 * additional linear walk per file. This is fine for test files (processed once
 * per index, typically small ASTs) and keeps the logic self-contained.
 *
 * Emitted `def.name` is the full chain-prefixed description string
 * (`Outer>Inner>test name`). This is what `testDetectPass.buildTestFunctionEdges`
 * uses as the test name for both the TESTS edge source_id and the name-heuristic
 * substring match.
 */
export declare function extractTestCaseDefinitions(rootNode: Node, definitions: ExtractedDefinition[]): void;
//# sourceMappingURL=treeSitterTestExtractor.d.ts.map
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

// ─── Test global sets ─────────────────────────────────────────────────────────

/**
 * Leaf test globals: emit Test nodes AND are valid TESTS-edge sources.
 * These map to individual test cases that actually exercise production code.
 */
export const LEAF_TEST_GLOBALS = new Set<string>([
  'it',
  'test',
  'it.only',
  'test.only',
  'it.skip',
  'test.skip',
  'xit',
  'xtest',
  'fit',
  'ftest',
  'it.todo',
  'test.todo',
]);

/**
 * Structural test globals: emit Test nodes for name-scoping only.
 * These are NOT TESTS-edge sources — they organize test cases but don't
 * exercise production code directly.
 *
 * `it.each` and `test.each` are treated as STRUCTURAL here to avoid the
 * complexity of table-driven `it.each(table)(name, fn)` callee extraction.
 * TODO(v0.3): table-driven it.each / test.each name extraction.
 */
export const STRUCTURAL_TEST_GLOBALS = new Set<string>([
  'describe',
  'describe.only',
  'describe.skip',
  'xdescribe',
  'fdescribe',
  'describe.each',
  'it.each',
  'test.each',
  // Aliases used by some frameworks (Mocha, Jest suites, Jasmine)
  'suite',
  'context',
]);

// ─── Callee-name extraction ───────────────────────────────────────────────────

/**
 * Resolve the callee name from a `call_expression` node.
 *
 * Handles two shapes:
 *   - `identifier` → 'it', 'describe', etc.
 *   - `member_expression` → 'it.only', 'describe.skip', etc.
 *
 * Returns null for anything else (e.g. a nested `call_expression` callee like
 * `it.each(table)` — those fall into STRUCTURAL via the set membership check,
 * but the callee name resolution for that outer call won't match here anyway;
 * the each-table call_expression itself won't match either set).
 */
function resolveCalleeName(callNode: Node): string | null {
  const calleeNode = callNode.childForFieldName('function');
  if (!calleeNode) return null;

  if (calleeNode.type === 'identifier') {
    return calleeNode.text;
  }

  if (calleeNode.type === 'member_expression') {
    const object = calleeNode.childForFieldName('object');
    const property = calleeNode.childForFieldName('property');
    if (object && property) {
      return `${object.text}.${property.text}`;
    }
  }

  // call_expression or other callee type — skip (e.g. it.each(table)).
  return null;
}

// ─── String-literal extraction ────────────────────────────────────────────────

/**
 * Extract the text of the first argument to a call_expression, but ONLY if it
 * is a plain string literal (tree-sitter `string` node). Template literals,
 * identifiers, and other non-string first-args return null — the caller skips
 * the node gracefully (emit nothing, per spec).
 */
function extractFirstStringArg(callNode: Node): string | null {
  const argsNode = callNode.childForFieldName('arguments');
  if (!argsNode) return null;

  const firstArg = argsNode.namedChild(0);
  if (!firstArg) return null;

  // Only plain string nodes — not template_string, identifier, etc.
  if (firstArg.type !== 'string') return null;

  // Strip surrounding quote characters and trim whitespace.
  const raw = firstArg.text;
  return raw.replace(/^['"`]|['"`]$/g, '').trim();
}

// ─── QN sanitization ─────────────────────────────────────────────────────────

/**
 * Sanitize a description string for use in a qualified name.
 * Replaces `>` (the QN separator) with `-` to prevent ambiguity.
 */
function sanitizeForQn(name: string): string {
  return name.replace(/>/g, '-');
}

// ─── Ancestor-based describe-chain resolution ─────────────────────────────────

/**
 * Walk UP via node.parent from a given call_expression to collect all enclosing
 * structural (describe-family) call_expression names, from outermost to innermost.
 *
 * Stops at `program` (the AST root) or at depth > 20 (pathological nesting guard).
 */
function resolveDescribeChain(callNode: Node): string[] {
  const chain: string[] = [];
  let current: Node | null = callNode.parent;
  let depth = 0;

  while (current !== null && current.type !== 'program' && depth < 20) {
    depth++;
    if (current.type === 'call_expression') {
      const callee = resolveCalleeName(current);
      if (callee !== null && STRUCTURAL_TEST_GLOBALS.has(callee)) {
        const label = extractFirstStringArg(current);
        if (label !== null) {
          // Unshift so the outermost describe ends up at index 0.
          chain.unshift(sanitizeForQn(label));
        }
      }
    }
    current = current.parent;
  }

  return chain;
}

// ─── Callback shape check ─────────────────────────────────────────────────────

/**
 * Return the second argument node if it is an arrow_function or
 * function_expression. Returns null if absent or a different shape.
 * Used to narrow the end-line of the emitted definition to the callback body.
 */
function extractCallbackNode(callNode: Node): Node | null {
  const argsNode = callNode.childForFieldName('arguments');
  if (!argsNode) return null;

  const secondArg = argsNode.namedChild(1);
  if (!secondArg) return null;

  if (secondArg.type === 'arrow_function' || secondArg.type === 'function_expression') {
    return secondArg;
  }
  return null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

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
export function extractTestCaseDefinitions(
  rootNode: Node,
  definitions: ExtractedDefinition[],
): void {
  const stack: Node[] = [rootNode];

  while (stack.length > 0) {
    const current = stack.pop()!;

    if (current.type === 'call_expression') {
      const calleeName = resolveCalleeName(current);

      if (calleeName !== null) {
        const isLeaf = LEAF_TEST_GLOBALS.has(calleeName);
        const isStructural = !isLeaf && STRUCTURAL_TEST_GLOBALS.has(calleeName);

        if (isLeaf || isStructural) {
          const rawLabel = extractFirstStringArg(current);

          // Skip gracefully if first arg is not a string literal.
          if (rawLabel !== null) {
            const describeChain = resolveDescribeChain(current);
            const safeLabel = sanitizeForQn(rawLabel);

            // Build the full chain-prefixed name.
            // E.g. describeChain = ['UserService', 'create'] + safeLabel = 'returns user'
            //   → name = 'UserService>create>returns user'
            const chainPrefixed =
              describeChain.length > 0
                ? `${describeChain.join('>')}>${safeLabel}`
                : safeLabel;

            const callbackNode = extractCallbackNode(current);
            const startLine = current.startPosition.row + 1;
            const endLine = (callbackNode ?? current).endPosition.row + 1;

            // Detect async callback: arrow_function or function_expression
            // whose first named child is the `async` keyword token.
            const isAsync =
              callbackNode !== null &&
              callbackNode.children.some((c) => c.type === 'async');

            definitions.push({
              name: chainPrefixed,
              kind: 'Test',
              signature: null,
              returnType: null,
              startLine,
              endLine,
              isExported: false,
              isDefault: false,
              isAsync,
              isStatic: false,
              isAbstract: false,
              decorators: [],
              receiver: null,
              constants: [],
            });
          }
        }
      }
    }

    // Enqueue children in reverse order to preserve left-to-right traversal order.
    const childCount = current.childCount;
    for (let i = childCount - 1; i >= 0; i--) {
      const child = current.child(i);
      if (child) stack.push(child);
    }
  }
}

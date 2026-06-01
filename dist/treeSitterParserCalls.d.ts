/**
 * treeSitterParserCalls.ts — Call-site extraction helpers extracted from
 * treeSitterParserSupport.ts to keep that file under 300 lines.
 *
 * Contains: CallNodeResult, extractCallNodeInfo, extractRouteCandidate,
 * extractHandlerName, and all inner helpers.
 */
import type { Node } from 'web-tree-sitter';
export interface CallNodeResult {
    calleeName: string | null;
    receiverName: string | null;
    isAsync: boolean;
}
export interface RouteCandidateInfo {
    objectText: string | null;
    methodText: string | null;
}
/** Extract caller/receiver/async info from any supported call node type. */
export declare function extractCallNodeInfo(node: Node, maxSigLen: number): CallNodeResult | null;
/** Extract object+method text from a call node for route pattern matching. */
export declare function extractRouteCandidate(node: Node): RouteCandidateInfo;
/** Extract handler name from the argument after the path. */
export declare function extractHandlerName(argsNode: Node, pathArgIndex: number): string | null;
export interface HttpCallArgs {
    firstArgValue: string | undefined;
    optionsMethod: string | undefined;
}
/**
 * Extract HTTP call arguments from the arguments node of a call site.
 *
 * - `firstArgValue`: raw text of the first argument if it is a string literal
 *   (`'...'`, `"..."`, backtick `\`...\``) or a template literal containing
 *   `${…}` expressions. Returns `undefined` for any other expression type
 *   (identifiers, binary expressions, computed members — i.e. non-static URLs).
 * - `optionsMethod`: value of the `method` property when the second argument
 *   is an object literal, e.g. `fetch(url, { method: 'POST' })`. Returns
 *   `undefined` if the second arg is absent, not an object literal, or does
 *   not contain a `method` key with a string-literal value.
 *
 * This is called once per call-node during the main AST walk — the parse tree
 * is freed after extraction, so the values must be captured here.
 */
export declare function extractHttpCallArgs(argsNode: Node | null | undefined): HttpCallArgs;
//# sourceMappingURL=treeSitterParserCalls.d.ts.map
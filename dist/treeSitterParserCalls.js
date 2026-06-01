/**
 * treeSitterParserCalls.ts — Call-site extraction helpers extracted from
 * treeSitterParserSupport.ts to keep that file under 300 lines.
 *
 * Contains: CallNodeResult, extractCallNodeInfo, extractRouteCandidate,
 * extractHandlerName, and all inner helpers.
 */
// ─── Inner helpers ────────────────────────────────────────────────────────────
function extractMemberOrFieldCall(fnNode) {
    return {
        receiverName: fnNode.childForFieldName('object')?.text ?? null,
        calleeName: (fnNode.childForFieldName('property') ?? fnNode.childForFieldName('field'))?.text ?? null,
    };
}
function extractAttributeCall(fnNode) {
    return {
        receiverName: fnNode.childForFieldName('object')?.text ?? null,
        calleeName: fnNode.childForFieldName('attribute')?.text ?? null,
    };
}
function extractCallExpression(node) {
    const fnNode = node.childForFieldName('function') ?? node.childForFieldName('method') ?? node.firstNamedChild;
    if (!fnNode)
        return null;
    const { type } = fnNode;
    if (type === 'member_expression' || type === 'field_expression')
        return extractMemberOrFieldCall(fnNode);
    if (type === 'identifier' || type === 'scoped_identifier')
        return { calleeName: fnNode.text, receiverName: null };
    if (type === 'attribute')
        return extractAttributeCall(fnNode);
    return null;
}
function extractInvocationExpression(node) {
    const fnNode = node.childForFieldName('function') ?? node.firstNamedChild;
    if (!fnNode)
        return null;
    if (fnNode.type === 'member_access_expression') {
        return {
            receiverName: fnNode.childForFieldName('expression')?.text ?? null,
            calleeName: fnNode.childForFieldName('name')?.text ?? null,
        };
    }
    return { calleeName: fnNode.text, receiverName: null };
}
function detectAsyncCall(node) {
    const parent = node.parent;
    if (!parent)
        return false;
    if (parent.type === 'await_expression')
        return true;
    return (parent.type === 'member_expression' &&
        parent.parent?.type === 'call_expression' &&
        parent.childForFieldName('property')?.text === 'then');
}
const CALL_NODE_EXTRACTORS = {
    call_expression: extractCallExpression,
    call: extractCallExpression,
    invocation_expression: extractInvocationExpression,
    new_expression: (n) => ({
        calleeName: (n.childForFieldName('constructor') ?? n.firstNamedChild)?.text ?? null,
        receiverName: null,
    }),
    object_creation_expression: (n) => ({
        calleeName: n.childForFieldName('type')?.text ?? null,
        receiverName: null,
    }),
    method_invocation: (n) => ({
        calleeName: n.childForFieldName('name')?.text ?? null,
        receiverName: n.childForFieldName('object')?.text ?? null,
    }),
    method_call: (n) => ({
        calleeName: n.childForFieldName('method')?.text ?? null,
        receiverName: null,
    }),
    function_call_expression: (n) => ({
        calleeName: (n.childForFieldName('function') ?? n.firstNamedChild)?.text ?? null,
        receiverName: null,
    }),
    method_call_expression: (n) => ({
        calleeName: n.childForFieldName('name')?.text ?? null,
        receiverName: n.childForFieldName('object')?.text ?? null,
    }),
};
// ─── Public API ───────────────────────────────────────────────────────────────
/** Extract caller/receiver/async info from any supported call node type. */
export function extractCallNodeInfo(node, maxSigLen) {
    const extractor = CALL_NODE_EXTRACTORS[node.type];
    if (!extractor)
        return null;
    const names = extractor(node);
    if (!names)
        return null;
    const { calleeName } = names;
    let { receiverName } = names;
    if (!calleeName)
        return null;
    if (receiverName && receiverName.length > maxSigLen) {
        receiverName = receiverName.slice(0, maxSigLen);
    }
    return { calleeName, receiverName, isAsync: detectAsyncCall(node) };
}
function extractMemberRouteCandidate(fnNode) {
    return {
        objectText: fnNode.childForFieldName('object')?.text ?? null,
        methodText: (fnNode.childForFieldName('property') ?? fnNode.childForFieldName('field'))?.text ?? null,
    };
}
function extractAttributeRouteCandidate(fnNode) {
    return {
        objectText: fnNode.childForFieldName('object')?.text ?? null,
        methodText: fnNode.childForFieldName('attribute')?.text ?? null,
    };
}
function extractRouteCandidateFromFn(fnNode) {
    const { type } = fnNode;
    if (type === 'member_expression' || type === 'field_expression')
        return extractMemberRouteCandidate(fnNode);
    if (type === 'attribute')
        return extractAttributeRouteCandidate(fnNode);
    return { objectText: null, methodText: null };
}
/** Extract object+method text from a call node for route pattern matching. */
export function extractRouteCandidate(node) {
    const fnNode = node.childForFieldName('function') ?? node.childForFieldName('method') ?? node.firstNamedChild;
    if (!fnNode)
        return { objectText: null, methodText: null };
    return extractRouteCandidateFromFn(fnNode);
}
/** Extract handler name from the argument after the path. */
export function extractHandlerName(argsNode, pathArgIndex) {
    const handlerArg = argsNode.namedChildren[pathArgIndex + 1];
    if (!handlerArg)
        return null;
    if (handlerArg.type === 'identifier')
        return handlerArg.text;
    if (handlerArg.type === 'member_expression') {
        return handlerArg.childForFieldName('property')?.text ?? null;
    }
    return null;
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
export function extractHttpCallArgs(argsNode) {
    if (!argsNode)
        return { firstArgValue: undefined, optionsMethod: undefined };
    const firstArg = argsNode.namedChildren[0];
    const firstArgValue = extractStringLiteralValue(firstArg);
    const secondArg = argsNode.namedChildren[1];
    const optionsMethod = extractObjectMethodProperty(secondArg);
    return { firstArgValue, optionsMethod };
}
/**
 * Return the raw text content of a string/template literal node, stripped of
 * its surrounding quotes. Returns `undefined` for non-literal node types.
 *
 * Accepted node types (tree-sitter names across JS/TS/Python/Go):
 *   string, string_literal, template_string, template_literal,
 *   interpreted_string_literal, raw_string_literal
 */
function extractStringLiteralValue(node) {
    if (!node)
        return undefined;
    const { type } = node;
    const isStringLiteral = type === 'string' ||
        type === 'string_literal' ||
        type === 'template_string' ||
        type === 'template_literal' ||
        type === 'interpreted_string_literal' ||
        type === 'raw_string_literal';
    if (!isStringLiteral)
        return undefined;
    // Strip surrounding quotes / backticks.
    return node.text.replace(/^['"`]|['"`]$/g, '');
}
/**
 * Given a node that may be an object literal (second arg to fetch, etc.), look
 * for a `method` property whose value is a string literal and return its text
 * (uppercased for normalisation). Returns `undefined` if the shape doesn't
 * match.
 *
 * Accepted object node types: object, object_expression, object_literal.
 */
function extractObjectMethodProperty(node) {
    if (!node)
        return undefined;
    const { type } = node;
    if (type !== 'object' && type !== 'object_expression' && type !== 'object_literal') {
        return undefined;
    }
    // Scan named children for a pair/property whose key is "method".
    for (const child of node.namedChildren) {
        // tree-sitter JS/TS: pair node has key + value fields.
        // tree-sitter also uses property/shorthand_property_identifier.
        const keyNode = child.childForFieldName('key') ??
            child.childForFieldName('name') ??
            child.firstNamedChild;
        if (!keyNode)
            continue;
        const keyText = keyNode.text.replace(/^['"`]|['"`]$/g, '');
        if (keyText !== 'method')
            continue;
        const valueNode = child.childForFieldName('value') ?? child.namedChildren[1];
        if (!valueNode)
            continue;
        const raw = extractStringLiteralValue(valueNode);
        if (raw !== undefined)
            return raw.toUpperCase();
    }
    return undefined;
}
//# sourceMappingURL=treeSitterParserCalls.js.map
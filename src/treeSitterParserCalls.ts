/**
 * treeSitterParserCalls.ts — Call-site extraction helpers extracted from
 * treeSitterParserSupport.ts to keep that file under 300 lines.
 *
 * Contains: CallNodeResult, extractCallNodeInfo, extractRouteCandidate,
 * extractHandlerName, and all inner helpers.
 */

import type { Node } from 'web-tree-sitter';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CallNodeResult {
  calleeName: string | null;
  receiverName: string | null;
  isAsync: boolean;
}

export interface RouteCandidateInfo {
  objectText: string | null;
  methodText: string | null;
}

type CallNames = Pick<CallNodeResult, 'calleeName' | 'receiverName'>;

// ─── Inner helpers ────────────────────────────────────────────────────────────

function extractMemberOrFieldCall(fnNode: Node): CallNames {
  return {
    receiverName: fnNode.childForFieldName('object')?.text ?? null,
    calleeName:
      (fnNode.childForFieldName('property') ?? fnNode.childForFieldName('field'))?.text ?? null,
  };
}

function extractAttributeCall(fnNode: Node): CallNames {
  return {
    receiverName: fnNode.childForFieldName('object')?.text ?? null,
    calleeName: fnNode.childForFieldName('attribute')?.text ?? null,
  };
}

function extractCallExpression(node: Node): CallNames | null {
  const fnNode =
    node.childForFieldName('function') ?? node.childForFieldName('method') ?? node.firstNamedChild;
  if (!fnNode) return null;

  const { type } = fnNode;
  if (type === 'member_expression' || type === 'field_expression')
    return extractMemberOrFieldCall(fnNode);
  if (type === 'identifier' || type === 'scoped_identifier')
    return { calleeName: fnNode.text, receiverName: null };
  if (type === 'attribute') return extractAttributeCall(fnNode);
  return null;
}

function extractInvocationExpression(node: Node): CallNames | null {
  const fnNode = node.childForFieldName('function') ?? node.firstNamedChild;
  if (!fnNode) return null;

  if (fnNode.type === 'member_access_expression') {
    return {
      receiverName: fnNode.childForFieldName('expression')?.text ?? null,
      calleeName: fnNode.childForFieldName('name')?.text ?? null,
    };
  }
  return { calleeName: fnNode.text, receiverName: null };
}

function detectAsyncCall(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'await_expression') return true;
  return (
    parent.type === 'member_expression' &&
    parent.parent?.type === 'call_expression' &&
    parent.childForFieldName('property')?.text === 'then'
  );
}

type CallNameExtractor = (n: Node) => CallNames | null;

const CALL_NODE_EXTRACTORS: Record<string, CallNameExtractor> = {
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
export function extractCallNodeInfo(
  node: Node,
  maxSigLen: number,
): CallNodeResult | null {
  const extractor = CALL_NODE_EXTRACTORS[node.type];
  if (!extractor) return null;

  const names = extractor(node);
  if (!names) return null;

  const { calleeName } = names;
  let { receiverName } = names;

  if (!calleeName) return null;
  if (receiverName && receiverName.length > maxSigLen) {
    receiverName = receiverName.slice(0, maxSigLen);
  }

  return { calleeName, receiverName, isAsync: detectAsyncCall(node) };
}

function extractMemberRouteCandidate(fnNode: Node): RouteCandidateInfo {
  return {
    objectText: fnNode.childForFieldName('object')?.text ?? null,
    methodText:
      (fnNode.childForFieldName('property') ?? fnNode.childForFieldName('field'))?.text ?? null,
  };
}

function extractAttributeRouteCandidate(fnNode: Node): RouteCandidateInfo {
  return {
    objectText: fnNode.childForFieldName('object')?.text ?? null,
    methodText: fnNode.childForFieldName('attribute')?.text ?? null,
  };
}

function extractRouteCandidateFromFn(fnNode: Node): RouteCandidateInfo {
  const { type } = fnNode;
  if (type === 'member_expression' || type === 'field_expression')
    return extractMemberRouteCandidate(fnNode);
  if (type === 'attribute') return extractAttributeRouteCandidate(fnNode);
  return { objectText: null, methodText: null };
}

/** Extract object+method text from a call node for route pattern matching. */
export function extractRouteCandidate(node: Node): RouteCandidateInfo {
  const fnNode =
    node.childForFieldName('function') ?? node.childForFieldName('method') ?? node.firstNamedChild;
  if (!fnNode) return { objectText: null, methodText: null };
  return extractRouteCandidateFromFn(fnNode);
}

/** Extract handler name from the argument after the path. */
export function extractHandlerName(
  argsNode: Node,
  pathArgIndex: number,
): string | null {
  const handlerArg = argsNode.namedChildren[pathArgIndex + 1];
  if (!handlerArg) return null;
  if (handlerArg.type === 'identifier') return handlerArg.text;
  if (handlerArg.type === 'member_expression') {
    return handlerArg.childForFieldName('property')?.text ?? null;
  }
  return null;
}

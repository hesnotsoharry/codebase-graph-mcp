/**
 * treeSitterParserSupport.ts — Helper functions extracted from treeSitterParser.ts
 * to keep the main file under the max-lines/max-lines-per-function limits.
 *
 * Language-specific import extractors live in treeSitterParserImports.ts.
 */

import type { Node } from 'web-tree-sitter';

import type { ExtractedImport, ImportSpecifier, LanguageConfig } from './treeSitterTypes';

// ─── Type detection helpers ───────────────────────────────────────────────────

/** Detect `import type { ... }` by checking sibling tokens. */
export function detectTypeOnlyImport(node: Node): boolean {
  const children = node.children;
  for (let i = 0; i < children.length - 1; i++) {
    // eslint-disable-next-line security/detect-object-injection -- i is a bounded loop index
    if (children[i].type === 'import' && children[i + 1]?.type === 'type') {
      return true;
    }
  }
  return false;
}

/** Collect named import specifiers (import { a, b as c }). */
export function collectNamedImports(node: Node, specifiers: ImportSpecifier[]): void {
  const namedImports = node.descendantsOfType('import_specifier');
  for (const spec of namedImports) {
    const nameNode = spec.childForFieldName('name') ?? spec.firstNamedChild;
    const aliasNode = spec.childForFieldName('alias');
    if (nameNode) {
      specifiers.push({
        name: aliasNode?.text ?? nameNode.text,
        originalName: aliasNode ? nameNode.text : null,
        isDefault: false,
        isNamespace: false,
      });
    }
  }
}

/** Collect default import from import_clause node. */
function collectDefaultImportFromClause(
  importClause: Node,
  specifiers: ImportSpecifier[],
): void {
  for (const child of importClause.namedChildren) {
    if (child.type !== 'identifier') continue;
    if (!specifiers.some((s) => s.name === child.text)) {
      specifiers.push({
        name: child.text,
        originalName: null,
        isDefault: true,
        isNamespace: false,
      });
    }
  }
}

/** Collect default import when import_clause is absent (fallback path). */
function collectDefaultImportFallback(
  node: Node,
  specifiers: ImportSpecifier[],
): void {
  const defaultIdent = node
    .descendantsOfType('identifier')
    .find((n) => n.parent?.type === 'import_clause' || n.parent?.type === node.type);

  if (!defaultIdent) return;
  if (specifiers.some((s) => s.name === defaultIdent.text)) return;
  if (defaultIdent.text === 'type') return;

  const parent = defaultIdent.parent;
  if (parent && parent.type !== 'named_imports' && parent.type !== 'namespace_import') {
    specifiers.push({
      name: defaultIdent.text,
      originalName: null,
      isDefault: true,
      isNamespace: false,
    });
  }
}

/** Collect namespace imports (import * as ns). */
export function collectNamespaceImports(
  node: Node,
  specifiers: ImportSpecifier[],
): void {
  const nsImports = node.descendantsOfType('namespace_import');
  for (const ns of nsImports) {
    const nameNode = ns.lastNamedChild;
    if (nameNode && nameNode.type === 'identifier') {
      specifiers.push({
        name: nameNode.text,
        originalName: null,
        isDefault: false,
        isNamespace: true,
      });
    }
  }
}

/** Collect the default import (from import_clause or fallback). */
export function collectDefaultImport(node: Node, specifiers: ImportSpecifier[]): void {
  const importClause = node.namedChildren.find((c) => c.type === 'import_clause');
  if (importClause) {
    collectDefaultImportFromClause(importClause, specifiers);
  } else {
    collectDefaultImportFallback(node, specifiers);
  }
}

// ─── Python import helpers ────────────────────────────────────────────────────

function makeAliasedSpecifier(
  nameNode: Node,
  aliasNode: Node | null | undefined,
  isNamespace: boolean,
): ImportSpecifier {
  const hasAlias = aliasNode && aliasNode !== nameNode;
  return {
    name: hasAlias ? aliasNode!.text : nameNode.text,
    originalName: hasAlias ? nameNode.text : null,
    isDefault: false,
    isNamespace,
  };
}

export function extractPythonFromStatement(node: Node): ExtractedImport | null {
  const moduleNode = node.childForFieldName('module_name');
  if (!moduleNode) return null;

  const importSource = moduleNode.text;
  const specifiers: ImportSpecifier[] = [];

  for (const child of node.namedChildren) {
    if (child === moduleNode) continue;
    if (child.type === 'dotted_name') {
      specifiers.push({
        name: child.text,
        originalName: null,
        isDefault: false,
        isNamespace: false,
      });
    } else if (child.type === 'aliased_import') {
      const nameNode = child.firstNamedChild;
      if (nameNode) specifiers.push(makeAliasedSpecifier(nameNode, child.lastNamedChild, false));
    }
  }

  return {
    source: importSource,
    specifiers,
    isTypeOnly: false,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

export function extractPythonPlainImport(node: Node): ExtractedImport | null {
  const names = node.descendantsOfType('dotted_name');
  if (names.length === 0) return null;

  const importSource = names[0].text;
  const specifiers: ImportSpecifier[] = [
    {
      name: importSource.split('.').pop() ?? importSource,
      originalName: null,
      isDefault: false,
      isNamespace: true,
    },
  ];

  const aliases = node.descendantsOfType('aliased_import');
  if (aliases.length > 0) {
    specifiers.length = 0;
    for (const alias of aliases) {
      const nameNode = alias.firstNamedChild;
      if (nameNode) specifiers.push(makeAliasedSpecifier(nameNode, alias.lastNamedChild, true));
    }
  }

  return {
    source: importSource,
    specifiers,
    isTypeOnly: false,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

// ─── Call extraction + route extraction (re-exported from companion file) ────

export type { CallNodeResult, RouteCandidateInfo } from './treeSitterParserCalls';
export {
  extractCallNodeInfo,
  extractHandlerName,
  extractRouteCandidate,
} from './treeSitterParserCalls';

// ─── isNodeExported helpers ───────────────────────────────────────────────────

function isExportedGo(node: Node): boolean {
  const nameNode = node.childForFieldName('name');
  return nameNode ? /^[A-Z]/.test(nameNode.text) : false;
}

function isExportedRust(node: Node): boolean {
  return node.children.some((c) => c.type === 'visibility_modifier');
}

function isExportedJavaLike(node: Node): boolean {
  const modifiers =
    node.childForFieldName('modifiers') ??
    node.namedChildren.find((c) => c.type === 'modifiers' || c.type === 'modifier');
  return modifiers ? modifiers.text.includes('public') : false;
}

/** Determine export status for non-TS/JS languages. */
export function resolveExportStatus(node: Node, config: LanguageConfig): boolean {
  if (config.id === 'go') return isExportedGo(node);
  if (config.id === 'rust') return isExportedRust(node);
  if (config.id === 'java' || config.id === 'c_sharp') return isExportedJavaLike(node);
  return true; // Python, Ruby, PHP: no explicit export
}

// ─── extractDecorators helpers ────────────────────────────────────────────────

function collectTsDecorators(node: Node, decorators: string[]): void {
  let sibling = node.previousNamedSibling;
  while (sibling && sibling.type === 'decorator') {
    const name = sibling.firstNamedChild?.text ?? sibling.text;
    decorators.push(name.replace(/^@/, ''));
    sibling = sibling.previousNamedSibling;
  }
}

function collectJavaAnnotations(node: Node, decorators: string[]): void {
  let sibling = node.previousNamedSibling;
  while (sibling && (sibling.type === 'marker_annotation' || sibling.type === 'annotation')) {
    const name = sibling.childForFieldName('name')?.text ?? sibling.text.replace(/^@/, '');
    if (!decorators.includes(name)) decorators.push(name);
    sibling = sibling.previousNamedSibling;
  }
}

/** Walk backwards collecting TypeScript/Python/Java decorator nodes. */
export function collectDecorators(node: Node): string[] {
  const decorators: string[] = [];
  collectTsDecorators(node, decorators);
  collectJavaAnnotations(node, decorators);
  return decorators;
}

// ─── extractSingleDefinition helpers ─────────────────────────────────────────

/** Extract the name node from a definition node. */
export function extractDefinitionNameNode(node: Node): Node | null {
  return (
    node.childForFieldName('name') ??
    node.namedChildren.find(
      (c) =>
        c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'property_identifier',
    ) ??
    null
  );
}

// ─── extractArrowFunctionExports helpers ──────────────────────────────────────

/** Check if a variable_declarator's value is an arrow/function expression. */
export function isArrowOrFunctionValue(valueNode: Node): boolean {
  return valueNode.type === 'arrow_function' || valueNode.type === 'function';
}

// ─── Parser helpers + definition builders (re-exported from companion file) ───

export {
  buildNodeTypeToLabelMap,
  collectExportedIdentifiers,
  extractArrowDeclarator,
  extractNodeSignature,
  extractReturnType,
  extractReturnTypeFromAnnotation,
  extractSingleDefinition,
  extractTopLevelNames,
  findAncestorOfType,
  hasModifier,
  isDefaultExport,
  isNodeExported,
} from './treeSitterParserDefs';

// ─── Language-specific import extractors (re-exported from companion file) ────

export {
  dispatchNonTsImport,
  extractCInclude,
  extractGoImport,
  extractJavaLikeImport,
  extractPhpImport,
  extractRubyImport,
  extractRustImport,
} from './treeSitterParserImports';

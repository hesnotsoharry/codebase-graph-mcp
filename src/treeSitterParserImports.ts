/**
 * treeSitterParserImports.ts — Language-specific import extractors for
 * non-TypeScript/JavaScript languages (Python, Go, Rust, Java, C#, C/C++,
 * Ruby, PHP).
 *
 * Extracted from treeSitterParserSupport.ts to keep that file under 300 lines.
 */

import type { Node } from 'web-tree-sitter';

import { extractPythonFromStatement, extractPythonPlainImport } from './treeSitterParserSupport';
import type { ExtractedImport, ImportSpecifier, LanguageConfig } from './treeSitterTypes';

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeNamespaceSpecifier(name: string): ImportSpecifier {
  return { name, originalName: null, isDefault: false, isNamespace: true };
}

function makeNamedSpecifier(name: string): ImportSpecifier {
  return { name, originalName: null, isDefault: false, isNamespace: false };
}

function makeImport(
  source: string,
  specifiers: ImportSpecifier[],
  startLine: number,
  endLine: number,
): ExtractedImport {
  return { source, specifiers, isTypeOnly: false, startLine, endLine };
}

// ─── Go ───────────────────────────────────────────────────────────────────────

export function extractGoImport(node: Node): ExtractedImport[] | null {
  if (node.type !== 'import_declaration') return null;

  const results: ExtractedImport[] = [];
  const interpretedStrings = node.descendantsOfType('interpreted_string_literal');
  for (const strNode of interpretedStrings) {
    const importSource = strNode.text.replace(/"/g, '');
    const shortName = importSource.split('/').pop() ?? importSource;
    results.push(
      makeImport(
        importSource,
        [makeNamespaceSpecifier(shortName)],
        strNode.startPosition.row + 1,
        strNode.endPosition.row + 1,
      ),
    );
  }
  return results.length > 0 ? results : null;
}

// ─── Rust ─────────────────────────────────────────────────────────────────────

export function extractRustImport(node: Node): ExtractedImport | null {
  if (node.type !== 'use_declaration') return null;
  const pathNode = node.namedChildren[0];
  if (!pathNode) return null;
  const importSource = pathNode.text.replace(/;$/, '').trim();
  const shortName = importSource.split('::').pop() ?? importSource;
  return makeImport(
    importSource,
    [makeNamedSpecifier(shortName.replace(/[{}]/g, '').trim())],
    node.startPosition.row + 1,
    node.endPosition.row + 1,
  );
}

// ─── Java / C# ────────────────────────────────────────────────────────────────

export function extractJavaLikeImport(node: Node): ExtractedImport | null {
  const scopedIdent = node.descendantsOfType('scoped_identifier');
  const ident =
    scopedIdent.length > 0 ? scopedIdent[scopedIdent.length - 1] : node.namedChildren[0];
  if (!ident) return null;
  const importSource = ident.text;
  const shortName = importSource.split('.').pop() ?? importSource;
  return makeImport(
    importSource,
    [{ name: shortName, originalName: null, isDefault: false, isNamespace: shortName === '*' }],
    node.startPosition.row + 1,
    node.endPosition.row + 1,
  );
}

// ─── C / C++ ──────────────────────────────────────────────────────────────────

export function extractCInclude(node: Node): ExtractedImport | null {
  if (node.type !== 'preproc_include') return null;
  const pathNode = node.namedChildren.find(
    (c) => c.type === 'string_literal' || c.type === 'system_lib_string',
  );
  if (!pathNode) return null;
  const importSource = pathNode.text.replace(/[<>"]/g, '');
  const shortName =
    importSource
      .replace(/\.h(pp)?$/, '')
      .split('/')
      .pop() ?? importSource;
  return makeImport(
    importSource,
    [makeNamespaceSpecifier(shortName)],
    node.startPosition.row + 1,
    node.endPosition.row + 1,
  );
}

// ─── Ruby ─────────────────────────────────────────────────────────────────────

export function extractRubyImport(node: Node): ExtractedImport | null {
  if (node.type !== 'call') return null;
  const methodNode = node.childForFieldName('method');
  if (!methodNode) return null;
  const methodName = methodNode.text;
  if (methodName !== 'require' && methodName !== 'require_relative') return null;
  const argsNode = node.childForFieldName('arguments');
  const firstArg = argsNode?.firstNamedChild;
  if (!firstArg) return null;
  const importSource = firstArg.text.replace(/['"]/g, '');
  return makeImport(
    importSource,
    [makeNamespaceSpecifier(importSource.split('/').pop() ?? importSource)],
    node.startPosition.row + 1,
    node.endPosition.row + 1,
  );
}

// ─── PHP ──────────────────────────────────────────────────────────────────────

export function extractPhpImport(node: Node): ExtractedImport | null {
  if (node.type !== 'namespace_use_declaration') return null;
  const nameNode = node.descendantsOfType('qualified_name')[0] ?? node.descendantsOfType('name')[0];
  if (!nameNode) return null;
  const importSource = nameNode.text;
  const shortName = importSource.split('\\').pop() ?? importSource;
  return makeImport(
    importSource,
    [makeNamedSpecifier(shortName)],
    node.startPosition.row + 1,
    node.endPosition.row + 1,
  );
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

type NonTsImportResult = ExtractedImport | ExtractedImport[] | null;

type NonTsExtractor = (node: Node) => NonTsImportResult;

const NON_TS_EXTRACTORS: Record<string, NonTsExtractor> = {
  go: extractGoImport,
  rust: extractRustImport,
  java: extractJavaLikeImport,
  c_sharp: extractJavaLikeImport,
  c: extractCInclude,
  cpp: extractCInclude,
  ruby: extractRubyImport,
  php: extractPhpImport,
};

/** Dispatch import extraction for non-TS/JS languages. */
export function dispatchNonTsImport(
  node: Node,
  config: LanguageConfig,
): NonTsImportResult {
  if (config.id === 'python') {
    if (node.type === 'import_from_statement') return extractPythonFromStatement(node);
    if (node.type === 'import_statement') return extractPythonPlainImport(node);
    return null;
  }
  const extractor = NON_TS_EXTRACTORS[config.id];
  return extractor ? extractor(node) : null;
}

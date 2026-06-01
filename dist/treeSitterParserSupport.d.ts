/**
 * treeSitterParserSupport.ts — Helper functions extracted from treeSitterParser.ts
 * to keep the main file under the max-lines/max-lines-per-function limits.
 *
 * Language-specific import extractors live in treeSitterParserImports.ts.
 */
import type { Node } from 'web-tree-sitter';
import type { ExtractedImport, ImportSpecifier, LanguageConfig } from './treeSitterTypes';
/** Detect `import type { ... }` by checking sibling tokens. */
export declare function detectTypeOnlyImport(node: Node): boolean;
/** Collect named import specifiers (import { a, b as c }). */
export declare function collectNamedImports(node: Node, specifiers: ImportSpecifier[]): void;
/** Collect namespace imports (import * as ns). */
export declare function collectNamespaceImports(node: Node, specifiers: ImportSpecifier[]): void;
/** Collect the default import (from import_clause or fallback). */
export declare function collectDefaultImport(node: Node, specifiers: ImportSpecifier[]): void;
export declare function extractPythonFromStatement(node: Node): ExtractedImport | null;
export declare function extractPythonPlainImport(node: Node): ExtractedImport | null;
export type { CallNodeResult, HttpCallArgs, RouteCandidateInfo } from './treeSitterParserCalls';
export { extractCallNodeInfo, extractHandlerName, extractHttpCallArgs, extractRouteCandidate, } from './treeSitterParserCalls';
/** Determine export status for non-TS/JS languages. */
export declare function resolveExportStatus(node: Node, config: LanguageConfig): boolean;
/** Walk backwards collecting TypeScript/Python/Java decorator nodes. */
export declare function collectDecorators(node: Node): string[];
/** Extract the name node from a definition node. */
export declare function extractDefinitionNameNode(node: Node): Node | null;
/** Check if a variable_declarator's value is an arrow/function expression. */
export declare function isArrowOrFunctionValue(valueNode: Node): boolean;
export { buildNodeTypeToLabelMap, collectExportedIdentifiers, extractArrowDeclarator, extractNodeSignature, extractReturnType, extractReturnTypeFromAnnotation, extractSingleDefinition, extractTopLevelNames, findAncestorOfType, hasModifier, isDefaultExport, isNodeExported, } from './treeSitterParserDefs';
export { dispatchNonTsImport, extractCInclude, extractGoImport, extractJavaLikeImport, extractPhpImport, extractRubyImport, extractRustImport, } from './treeSitterParserImports';
//# sourceMappingURL=treeSitterParserSupport.d.ts.map
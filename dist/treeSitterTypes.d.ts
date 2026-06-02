/**
 * treeSitterTypes.ts — Type definitions for tree-sitter AST extraction.
 *
 * Defines the shapes of extracted definitions, imports, calls, routes,
 * and parsed file results. Also defines the per-language configuration
 * interface that maps tree-sitter node types to graph labels.
 */
import type { NodeLabel } from './graphDatabaseTypes';
export type { NodeLabel };
export interface ExtractedDefinition {
    name: string;
    kind: NodeLabel;
    signature: string | null;
    returnType: string | null;
    startLine: number;
    endLine: number;
    isExported: boolean;
    isDefault: boolean;
    isAsync: boolean;
    isStatic: boolean;
    isAbstract: boolean;
    decorators: string[];
    receiver: string | null;
    constants: string[];
    implements?: string[];
    extendsClause?: string | null;
}
export interface ExtractedImport {
    source: string;
    specifiers: ImportSpecifier[];
    isTypeOnly: boolean;
    startLine: number;
    endLine: number;
}
export interface ImportSpecifier {
    name: string;
    originalName: string | null;
    isDefault: boolean;
    isNamespace: boolean;
}
export interface ExtractedCall {
    calleeName: string;
    receiverName: string | null;
    startLine: number;
    isAsync: boolean;
    arguments: number;
    isNewExpression: boolean;
    firstArgValue?: string;
    optionsMethod?: string;
}
export interface ExtractedRoute {
    method: string;
    path: string;
    handlerName: string | null;
    framework: string;
    startLine: number;
}
export interface ParsedFileResult {
    filePath: string;
    language: string;
    lineCount: number;
    definitions: ExtractedDefinition[];
    imports: ExtractedImport[];
    calls: ExtractedCall[];
    routes: ExtractedRoute[];
    exportedNames: string[];
    /**
     * True when the tree-sitter parse tree contains ERROR or MISSING nodes
     * (i.e. `tree.rootNode.hasError === true`). Populated by TreeSitterParser.
     * A false value means the grammar accepted the file without any syntax
     * errors — even if zero definitions were extracted.
     */
    hasParseError: boolean;
    /**
     * 1-based line number of the first ERROR or MISSING node, when hasParseError
     * is true. Null when the file parsed cleanly.
     */
    firstErrorLine: number | null;
}
export type LanguageId = 'typescript' | 'tsx' | 'javascript' | 'jsx' | 'python' | 'go' | 'rust' | 'java' | 'c' | 'cpp' | 'c_sharp' | 'ruby' | 'php' | 'swift' | 'kotlin' | 'scala' | 'lua' | 'bash' | 'css' | 'html' | 'json' | 'yaml' | 'toml';
export interface LanguageConfig {
    id: LanguageId;
    wasmFile: string;
    extensions: string[];
    functionNodes: string[];
    classNodes: string[];
    interfaceNodes: string[];
    typeNodes: string[];
    enumNodes: string[];
    methodNodes: string[];
    importNodes: string[];
    callNodes: string[];
    exportKeyword: string | null;
    routePatterns: RoutePattern[];
}
export interface RoutePattern {
    framework: string;
    receiverNames: string[];
    methodNames: string[];
    pathArgIndex: number;
}
//# sourceMappingURL=treeSitterTypes.d.ts.map
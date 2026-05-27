/**
 * treeSitterTypes.ts — Type definitions for tree-sitter AST extraction.
 *
 * Defines the shapes of extracted definitions, imports, calls, routes,
 * and parsed file results. Also defines the per-language configuration
 * interface that maps tree-sitter node types to graph labels.
 */

import type { NodeLabel } from './graphDatabaseTypes';
export type { NodeLabel };

// ─── Extraction results ──────────────────────────────────────────────────────

export interface ExtractedDefinition {
  name: string;
  kind: NodeLabel; // Function, Class, Interface, Type, Enum, Method, Route
  signature: string | null; // "(params): ReturnType" or null
  returnType: string | null;
  startLine: number; // 1-based (converted from tree-sitter's 0-based row)
  endLine: number;
  isExported: boolean;
  isDefault: boolean;
  isAsync: boolean;
  isStatic: boolean;
  isAbstract: boolean;
  decorators: string[];
  receiver: string | null; // For methods: the class name
  constants: string[]; // For modules: exported constants
  // Wave 21 Phase 1 — class_heritage fields (TS/TSX only; undefined for non-Class kinds)
  // `implements` is legal as an interface field name in TypeScript (reserved only as a statement keyword).
  implements?: string[]; // identifier names from implements_clause
  extendsClause?: string | null; // single identifier from extends_clause; null for Class kinds with no extends clause; undefined for non-Class kinds
}

export interface ExtractedImport {
  source: string; // Module specifier: './utils', 'react', '@scope/pkg'
  specifiers: ImportSpecifier[];
  isTypeOnly: boolean; // `import type { ... }`
  startLine: number;
  endLine: number;
}

export interface ImportSpecifier {
  name: string; // Local name
  originalName: string | null; // Original name if renamed (import { foo as bar })
  isDefault: boolean;
  isNamespace: boolean; // import * as ns
}

export interface ExtractedCall {
  calleeName: string; // Function/method being called
  receiverName: string | null; // For method calls: `obj.method()` -> receiver = 'obj'
  startLine: number;
  isAsync: boolean; // await or .then()
  arguments: number; // Argument count (for disambiguation)
  isNewExpression: boolean; // true when call site is `new Foo()` — used to prefer Class over Function in resolver
}

export interface ExtractedRoute {
  method: string; // GET, POST, PUT, DELETE, PATCH, ALL
  path: string; // '/api/users/:id'
  handlerName: string | null; // Name of the handler function
  framework: string; // express, fastify, koa, hono, etc.
  startLine: number;
}

export interface ParsedFileResult {
  filePath: string; // Relative path
  language: string; // Detected language ID
  lineCount: number;
  definitions: ExtractedDefinition[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  routes: ExtractedRoute[];
  exportedNames: string[]; // All names exported from this file
}

// ─── Language configuration ──────────────────────────────────────────────────

export type LanguageId =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'c_sharp'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'kotlin'
  | 'scala'
  | 'lua'
  | 'bash'
  | 'css'
  | 'html'
  | 'json'
  | 'yaml'
  | 'toml';

export interface LanguageConfig {
  id: LanguageId;
  wasmFile: string; // Filename in tree-sitter-wasms/out/
  extensions: string[]; // File extensions (without dot)
  // Tree-sitter node types that map to our graph labels
  functionNodes: string[];
  classNodes: string[];
  interfaceNodes: string[];
  typeNodes: string[];
  enumNodes: string[];
  methodNodes: string[];
  importNodes: string[];
  callNodes: string[];
  exportKeyword: string | null; // The export modifier node type
  // Route detection patterns (framework-specific)
  routePatterns: RoutePattern[];
}

export interface RoutePattern {
  framework: string;
  // Object name: 'app', 'router', 'r', 'server'
  receiverNames: string[];
  // Method names: 'get', 'post', 'put', 'delete', 'patch', 'all', 'use'
  methodNames: string[];
  // How to extract path: first argument to the method call
  pathArgIndex: number;
}

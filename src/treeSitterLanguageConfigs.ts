/**
 * treeSitterLanguageConfigs.ts — Per-language tree-sitter configurations.
 *
 * Maps tree-sitter AST node types to our graph node labels for each supported
 * language. Includes route detection patterns for web frameworks (Express,
 * FastAPI, Gin, etc.) and an extension-to-config lookup.
 *
 * Grammar source (v0.3.1): @vscode/tree-sitter-wasm (wasm/ directory).
 * Grammars present: typescript, tsx, javascript, python, go, rust, java,
 *   cpp, ruby, php, c-sharp (filename: tree-sitter-c-sharp.wasm).
 * Grammars absent from @vscode/tree-sitter-wasm, fallback to tree-sitter-wasms:
 *   c (tree-sitter-c.wasm).
 * Path resolution and c_sharp→c-sharp rename handled in treeSitterParser.ts
 * resolveGrammarPath(). wasmFile values here use canonical underscore names.
 */

import type { LanguageConfig } from './treeSitterTypes';

// ─── TypeScript ──────────────────────────────────────────────────────────────

export const typescriptConfig: LanguageConfig = {
  id: 'typescript',
  wasmFile: 'tree-sitter-typescript.wasm',
  extensions: ['ts', 'mts', 'cts'],
  functionNodes: [
    'function_declaration', // function foo() {}
    'generator_function_declaration', // function* foo() {}
  ],
  classNodes: [
    'class_declaration', // class Foo {}
    'abstract_class_declaration', // abstract class Foo {}
  ],
  interfaceNodes: [
    'interface_declaration', // interface IFoo {}
  ],
  typeNodes: [
    'type_alias_declaration', // type Foo = ...
  ],
  enumNodes: [
    'enum_declaration', // enum Foo {}
  ],
  methodNodes: [
    'method_definition', // class body method
    'public_field_definition', // class property (check if arrow fn)
  ],
  importNodes: [
    'import_statement', // import { x } from 'y'
  ],
  callNodes: [
    'call_expression', // foo()
    'new_expression', // new Foo()
  ],
  exportKeyword: 'export_statement',
  routePatterns: [
    {
      framework: 'express',
      receiverNames: ['app', 'router', 'route', 'server'],
      methodNames: ['get', 'post', 'put', 'delete', 'patch', 'all', 'use', 'options', 'head'],
      pathArgIndex: 0,
    },
    {
      framework: 'fastify',
      receiverNames: ['fastify', 'app', 'server', 'instance'],
      methodNames: ['get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head'],
      pathArgIndex: 0,
    },
    {
      framework: 'hono',
      receiverNames: ['app', 'hono'],
      methodNames: ['get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head'],
      pathArgIndex: 0,
    },
  ],
};

export const tsxConfig: LanguageConfig = {
  ...typescriptConfig,
  id: 'tsx',
  wasmFile: 'tree-sitter-tsx.wasm',
  extensions: ['tsx'],
};

// ─── JavaScript ──────────────────────────────────────────────────────────────

export const javascriptConfig: LanguageConfig = {
  ...typescriptConfig,
  id: 'javascript',
  wasmFile: 'tree-sitter-javascript.wasm',
  extensions: ['js', 'mjs', 'cjs', 'jsx'],
  interfaceNodes: [], // No interfaces in JS
  typeNodes: [], // No type aliases in JS
  enumNodes: [], // No enums in JS
};

// ─── Python ──────────────────────────────────────────────────────────────────

export const pythonConfig: LanguageConfig = {
  id: 'python',
  wasmFile: 'tree-sitter-python.wasm',
  extensions: ['py', 'pyi'],
  functionNodes: ['function_definition'],
  classNodes: ['class_definition'],
  interfaceNodes: [], // Python uses ABC/Protocol but they parse as classes
  typeNodes: [],
  enumNodes: [],
  methodNodes: ['function_definition'], // Demoted to Function in extractSingleDefinition when no class ancestor
  importNodes: ['import_statement', 'import_from_statement'],
  callNodes: ['call'],
  exportKeyword: null, // Python exports via __all__ or convention
  routePatterns: [
    {
      framework: 'fastapi',
      receiverNames: ['app', 'router', 'api'],
      methodNames: ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'],
      pathArgIndex: 0,
    },
    {
      framework: 'flask',
      receiverNames: ['app', 'blueprint', 'bp'],
      methodNames: ['route', 'get', 'post', 'put', 'delete', 'patch'],
      pathArgIndex: 0,
    },
    {
      framework: 'django',
      receiverNames: ['path', 'url', 're_path'],
      methodNames: [], // path() is a function, not a method
      pathArgIndex: 0,
    },
  ],
};

// ─── Go ──────────────────────────────────────────────────────────────────────

export const goConfig: LanguageConfig = {
  id: 'go',
  wasmFile: 'tree-sitter-go.wasm',
  extensions: ['go'],
  functionNodes: ['function_declaration'],
  classNodes: [], // Go has no classes
  interfaceNodes: [], // Go interfaces are type_spec with interface_type
  typeNodes: ['type_declaration'], // type Foo struct{} / type Foo interface{}
  enumNodes: [], // Go has no enums (const iota blocks)
  methodNodes: ['method_declaration'],
  importNodes: ['import_declaration'],
  callNodes: ['call_expression'],
  exportKeyword: null, // Go exports via uppercase first letter
  routePatterns: [
    {
      framework: 'gin',
      receiverNames: ['r', 'router', 'group', 'g', 'engine'],
      methodNames: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'Any'],
      pathArgIndex: 0,
    },
    {
      framework: 'chi',
      receiverNames: ['r', 'router', 'mux'],
      methodNames: ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Options', 'Head'],
      pathArgIndex: 0,
    },
    {
      framework: 'http',
      receiverNames: ['http'],
      methodNames: ['HandleFunc', 'Handle'],
      pathArgIndex: 0,
    },
  ],
};

// ─── Rust ─────────────────────────────────────────────────────────────────────

export const rustConfig: LanguageConfig = {
  id: 'rust',
  wasmFile: 'tree-sitter-rust.wasm',
  extensions: ['rs'],
  functionNodes: ['function_item'],
  classNodes: [],
  interfaceNodes: ['trait_item'],
  typeNodes: ['type_item', 'struct_item'],
  enumNodes: ['enum_item'],
  methodNodes: ['function_item'], // Demoted to Function in extractSingleDefinition when no impl_item ancestor
  importNodes: ['use_declaration'],
  callNodes: ['call_expression'],
  exportKeyword: null, // Rust exports via `pub`
  routePatterns: [
    {
      framework: 'actix',
      receiverNames: ['web'],
      methodNames: ['get', 'post', 'put', 'delete', 'patch', 'resource'],
      pathArgIndex: 0,
    },
    {
      framework: 'axum',
      receiverNames: ['Router'],
      methodNames: ['route', 'get', 'post', 'put', 'delete', 'patch'],
      pathArgIndex: 0,
    },
  ],
};

// ─── Java ─────────────────────────────────────────────────────────────────────

export const javaConfig: LanguageConfig = {
  id: 'java',
  wasmFile: 'tree-sitter-java.wasm',
  extensions: ['java'],
  functionNodes: [], // Java only has methods
  classNodes: ['class_declaration'],
  interfaceNodes: ['interface_declaration'],
  typeNodes: [],
  enumNodes: ['enum_declaration'],
  methodNodes: ['method_declaration', 'constructor_declaration'],
  importNodes: ['import_declaration'],
  callNodes: ['method_invocation', 'object_creation_expression'],
  exportKeyword: null, // Java exports via `public`
  routePatterns: [
    {
      framework: 'spring',
      receiverNames: [], // Spring uses annotations, not method calls
      methodNames: [],
      pathArgIndex: 0,
    },
  ],
};

// ─── C / C++ ──────────────────────────────────────────────────────────────────

export const cConfig: LanguageConfig = {
  id: 'c',
  wasmFile: 'tree-sitter-c.wasm',
  extensions: ['c', 'h'],
  functionNodes: ['function_definition'],
  classNodes: [],
  interfaceNodes: [],
  typeNodes: ['type_definition', 'struct_specifier'],
  enumNodes: ['enum_specifier'],
  methodNodes: [],
  importNodes: ['preproc_include'],
  callNodes: ['call_expression'],
  exportKeyword: null,
  routePatterns: [],
};

export const cppConfig: LanguageConfig = {
  ...cConfig,
  id: 'cpp',
  wasmFile: 'tree-sitter-cpp.wasm',
  extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
  classNodes: ['class_specifier'],
  methodNodes: ['function_definition'], // Inside class scope
};

// ─── Other languages (minimal configs for structure + definition extraction) ─

export const csharpConfig: LanguageConfig = {
  id: 'c_sharp',
  wasmFile: 'tree-sitter-c_sharp.wasm',
  extensions: ['cs'],
  functionNodes: [],
  classNodes: ['class_declaration', 'record_declaration'],
  interfaceNodes: ['interface_declaration'],
  typeNodes: ['struct_declaration'],
  enumNodes: ['enum_declaration'],
  methodNodes: ['method_declaration', 'constructor_declaration'],
  importNodes: ['using_directive'],
  callNodes: ['invocation_expression', 'object_creation_expression'],
  exportKeyword: null,
  routePatterns: [],
};

export const rubyConfig: LanguageConfig = {
  id: 'ruby',
  wasmFile: 'tree-sitter-ruby.wasm',
  extensions: ['rb'],
  functionNodes: ['method'],
  classNodes: ['class'],
  interfaceNodes: ['module'],
  typeNodes: [],
  enumNodes: [],
  methodNodes: ['method', 'singleton_method'],
  importNodes: ['call'], // require/require_relative are calls
  callNodes: ['call', 'method_call'],
  exportKeyword: null,
  routePatterns: [
    {
      framework: 'rails',
      receiverNames: [],
      methodNames: ['get', 'post', 'put', 'delete', 'patch', 'resources', 'resource'],
      pathArgIndex: 0,
    },
  ],
};

export const phpConfig: LanguageConfig = {
  id: 'php',
  wasmFile: 'tree-sitter-php.wasm',
  extensions: ['php'],
  functionNodes: ['function_definition'],
  classNodes: ['class_declaration'],
  interfaceNodes: ['interface_declaration'],
  typeNodes: [],
  enumNodes: ['enum_declaration'],
  methodNodes: ['method_declaration'],
  importNodes: ['namespace_use_declaration'],
  callNodes: ['function_call_expression', 'method_call_expression'],
  exportKeyword: null,
  routePatterns: [
    {
      framework: 'laravel',
      receiverNames: ['Route'],
      methodNames: ['get', 'post', 'put', 'delete', 'patch', 'resource'],
      pathArgIndex: 0,
    },
  ],
};

// ─── Extension -> Config mapping ─────────────────────────────────────────────

const allConfigs: LanguageConfig[] = [
  typescriptConfig,
  tsxConfig,
  javascriptConfig,
  pythonConfig,
  goConfig,
  rustConfig,
  javaConfig,
  cConfig,
  cppConfig,
  csharpConfig,
  rubyConfig,
  phpConfig,
];

const extensionMap = new Map<string, LanguageConfig>();
for (const config of allConfigs) {
  for (const ext of config.extensions) {
    extensionMap.set(ext, config);
  }
}

/**
 * Get the language configuration for a given file extension.
 * Accepts extensions with or without a leading dot.
 * Returns null for unsupported extensions.
 */
export function getLanguageConfig(fileExtension: string): LanguageConfig | null {
  return extensionMap.get(fileExtension.replace(/^\./, '')) ?? null;
}

/**
 * Get all file extensions supported by the tree-sitter parser.
 * Returns extensions without leading dots (e.g. 'ts', 'py', 'go').
 */
export function getSupportedExtensions(): string[] {
  return Array.from(extensionMap.keys());
}

export { allConfigs };

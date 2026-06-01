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
export declare const typescriptConfig: LanguageConfig;
export declare const tsxConfig: LanguageConfig;
export declare const javascriptConfig: LanguageConfig;
export declare const pythonConfig: LanguageConfig;
export declare const goConfig: LanguageConfig;
export declare const rustConfig: LanguageConfig;
export declare const javaConfig: LanguageConfig;
export declare const cConfig: LanguageConfig;
export declare const cppConfig: LanguageConfig;
export declare const csharpConfig: LanguageConfig;
export declare const rubyConfig: LanguageConfig;
export declare const phpConfig: LanguageConfig;
declare const allConfigs: LanguageConfig[];
/**
 * Get the language configuration for a given file extension.
 * Accepts extensions with or without a leading dot.
 * Returns null for unsupported extensions.
 */
export declare function getLanguageConfig(fileExtension: string): LanguageConfig | null;
/**
 * Get all file extensions supported by the tree-sitter parser.
 * Returns extensions without leading dots (e.g. 'ts', 'py', 'go').
 */
export declare function getSupportedExtensions(): string[];
export { allConfigs };
//# sourceMappingURL=treeSitterLanguageConfigs.d.ts.map
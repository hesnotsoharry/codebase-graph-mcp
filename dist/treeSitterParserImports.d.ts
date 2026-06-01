/**
 * treeSitterParserImports.ts — Language-specific import extractors for
 * non-TypeScript/JavaScript languages (Python, Go, Rust, Java, C#, C/C++,
 * Ruby, PHP).
 *
 * Extracted from treeSitterParserSupport.ts to keep that file under 300 lines.
 */
import type { Node } from 'web-tree-sitter';
import type { ExtractedImport, LanguageConfig } from './treeSitterTypes';
export declare function extractGoImport(node: Node): ExtractedImport[] | null;
export declare function extractRustImport(node: Node): ExtractedImport | null;
export declare function extractJavaLikeImport(node: Node): ExtractedImport | null;
export declare function extractCInclude(node: Node): ExtractedImport | null;
export declare function extractRubyImport(node: Node): ExtractedImport | null;
export declare function extractPhpImport(node: Node): ExtractedImport | null;
type NonTsImportResult = ExtractedImport | ExtractedImport[] | null;
/** Dispatch import extraction for non-TS/JS languages. */
export declare function dispatchNonTsImport(node: Node, config: LanguageConfig): NonTsImportResult;
export {};
//# sourceMappingURL=treeSitterParserImports.d.ts.map
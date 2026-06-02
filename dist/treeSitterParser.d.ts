/**
 * treeSitterParser.ts — WASM-based tree-sitter parser for multi-language
 * source code analysis. Extracts definitions, imports, calls, and routes.
 *
 * Grammars are loaded lazily on first use per extension and cached.
 * Concurrent loads of the same grammar are deduped via pendingLanguageLoads.
 * Grammar load failures mark the language as unsupported for the session
 * (no retry noise) and parseFile returns null for those files.
 */
import type { ImportSpecifier, ParsedFileResult } from './treeSitterTypes';
export declare class TreeSitterParser {
    private parser;
    private languages;
    private pendingLanguageLoads;
    private unsupportedLanguages;
    private initialized;
    init(): Promise<void>;
    private loadLanguage;
    private tryLoadOne;
    private doLoadLanguage;
    parseFile(relativePath: string, source: string): Promise<ParsedFileResult | null>;
    private extractDefinitions;
    private extractArrowFunctions;
    private extractImports;
    private dispatchImportExtractor;
    private extractTsJsImport;
    private extractCalls;
    private matchRoutePattern;
    private extractRoutes;
    private walkTree;
    /**
     * Returns the 1-based line number of the first ERROR or MISSING node in the
     * subtree rooted at `node`. Returns null if none found (caller should only
     * call this when hasParseError is true, so null here would be unexpected).
     */
    private findFirstErrorLine;
    private extractExportedNames;
    dispose(): void;
}
export type { ImportSpecifier };
//# sourceMappingURL=treeSitterParser.d.ts.map
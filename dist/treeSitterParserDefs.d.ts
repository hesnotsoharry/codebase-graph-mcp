/**
 * treeSitterParserDefs.ts — Definition-building and AST utility helpers
 * extracted from treeSitterParserSupport.ts to keep that file under 300 lines.
 *
 * Contains: buildNodeTypeToLabelMap, hasModifier, findAncestorOfType,
 * extractReturnType, extractReturnTypeFromAnnotation, extractNodeSignature,
 * extractTopLevelNames, extractSingleDefinition, extractArrowDeclarator,
 * isNodeExported, isDefaultExport, collectExportedIdentifiers.
 */
import type { Node } from 'web-tree-sitter';
import type { ExtractedDefinition, LanguageConfig } from './treeSitterTypes';
export declare function buildNodeTypeToLabelMap(config: LanguageConfig): Map<string, string>;
export declare function hasModifier(node: Node, modifier: string): boolean;
export declare function findAncestorOfType(node: Node, types: string[]): Node | null;
export declare function extractReturnType(node: Node): string | null;
export declare function extractReturnTypeFromAnnotation(declarator: Node): string | null;
export declare function extractNodeSignature(node: Node): string | null;
export declare function extractTopLevelNames(rootNode: Node, config: LanguageConfig): string[];
export declare function isNodeExported(node: Node, config: LanguageConfig): boolean;
export declare function isDefaultExport(node: Node): boolean;
export declare function extractSingleDefinition(node: Node, label: string, config: LanguageConfig): ExtractedDefinition | null;
export interface ArrowDeclaratorContext {
    existingNames: Set<string>;
    definitions: ExtractedDefinition[];
    isExported?: boolean;
}
export declare function extractArrowDeclarator(statementNode: Node, declarator: Node, ctx: ArrowDeclaratorContext): void;
/** Collect exported identifier names from an export_statement node via walkFn. */
export declare function collectExportedIdentifiers(exportNode: Node, walkFn: (node: Node, cb: (n: Node) => void) => void, names: Set<string>): void;
//# sourceMappingURL=treeSitterParserDefs.d.ts.map
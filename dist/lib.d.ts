/**
 * codebaseGraph/index.ts -- Barrel export for the codebase graph subsystem.
 */
export type { GraphControllerLike } from './graphControllerSupport';
export { acquireGraphController, getGraphController, getGraphControllerForRoot, releaseGraphController, } from './graphControllerSupport';
export { GraphDatabase } from './graphDatabase';
export type { ADRRecord, ADRSection, BaseNodeProps, ClassProps, EdgeType, EnumProps, FileHashRecord, FileProps, FolderProps, FunctionProps, GraphEdge, GraphNode, InterfaceProps, MethodProps, ModuleProps, NodeFilter, NodeLabel, NodeSearchResult, PackageProps, ProjectProps, ProjectRecord, RouteProps, TypeProps, } from './graphDatabaseTypes';
export { getLanguageConfig, getSupportedExtensions } from './treeSitterLanguageConfigs';
export { TreeSitterParser } from './treeSitterParser';
export type { ExtractedCall, ExtractedDefinition, ExtractedImport, ExtractedRoute, ImportSpecifier, LanguageConfig, LanguageId, ParsedFileResult, RoutePattern, } from './treeSitterTypes';
export { IndexingPipeline } from './indexingPipeline';
export type { DiscoveredFile, IndexedFile, IndexingOptions, IndexingProgress, IndexingResult, } from './indexingPipelineTypes';
export { CypherEngine } from './cypherEngine';
export { QueryEngine } from './queryEngine';
export type { ArchitectureAspect, ArchitectureResult, ChangedFileInfo, ChangedSymbol, ChangeScope, CodeSearchOptions, CodeSearchResult, DetectChangesOptions, DetectChangesResult, GraphSchemaResult, ImpactedCaller, RiskLevel, TraceCallPathOptions, TraceEdge, TraceNode, TraceResult, } from './queryEngineTypes';
export type { GraphToolContext } from './mcpToolHandlers';
export { createGraphMcpTools } from './mcpToolHandlers';
export { AutoSyncWatcher } from './autoSync';
//# sourceMappingURL=lib.d.ts.map
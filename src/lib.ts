/**
 * codebaseGraph/index.ts -- Barrel export for the codebase graph subsystem.
 */

// ---- Controller registry ----------------------------------------------------
export type { GraphControllerLike } from './graphControllerSupport';
export {
  acquireGraphController,
  getGraphController,
  getGraphControllerForRoot,
  releaseGraphController,
} from './graphControllerSupport';

// ---- Database (Phase 1) -----------------------------------------------------
export { GraphDatabase } from './graphDatabase';
export type {
  ADRRecord,
  ADRSection,
  BaseNodeProps,
  ClassProps,
  EdgeType,
  EnumProps,
  FileHashRecord,
  FileProps,
  FolderProps,
  FunctionProps,
  GraphEdge,
  GraphNode,
  InterfaceProps,
  MethodProps,
  ModuleProps,
  NodeFilter,
  NodeLabel,
  NodeSearchResult,
  PackageProps,
  ProjectProps,
  ProjectRecord,
  RouteProps,
  TypeProps,
} from './graphDatabaseTypes';

// ---- Tree-sitter parser (Phase 2) ------------------------------------------
export { getLanguageConfig, getSupportedExtensions } from './treeSitterLanguageConfigs';
export { TreeSitterParser } from './treeSitterParser';
export type {
  ExtractedCall,
  ExtractedDefinition,
  ExtractedImport,
  ExtractedRoute,
  ImportSpecifier,
  LanguageConfig,
  LanguageId,
  ParsedFileResult,
  RoutePattern,
} from './treeSitterTypes';

// ---- Indexing pipeline (Phase 3) --------------------------------------------
export { IndexingPipeline } from './indexingPipeline';
export type {
  DiscoveredFile,
  IndexedFile,
  IndexingOptions,
  IndexingProgress,
  IndexingResult,
} from './indexingPipelineTypes';

// ---- Query engines (Phase 5) ------------------------------------------------
export { CypherEngine } from './cypherEngine';
export { QueryEngine } from './queryEngine';
export type {
  ArchitectureAspect,
  ArchitectureResult,
  ChangedFileInfo,
  ChangedSymbol,
  ChangeScope,
  CodeSearchOptions,
  CodeSearchResult,
  DetectChangesOptions,
  DetectChangesResult,
  GraphSchemaResult,
  ImpactedCaller,
  RiskLevel,
  TraceCallPathOptions,
  TraceEdge,
  TraceNode,
  TraceResult,
} from './queryEngineTypes';

// ---- MCP tool handlers (Phase 6) --------------------------------------------
export type { GraphToolContext } from './mcpToolHandlers';
export { createGraphMcpTools } from './mcpToolHandlers';

// ---- Auto-sync watcher (Phase 7) --------------------------------------------
export { AutoSyncWatcher } from './autoSync';

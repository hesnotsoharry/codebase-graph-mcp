/**
 * codebaseGraph/index.ts -- Barrel export for the codebase graph subsystem.
 */
export { acquireGraphController, getGraphController, getGraphControllerForRoot, releaseGraphController, } from './graphControllerSupport.js';
// ---- Database (Phase 1) -----------------------------------------------------
export { GraphDatabase } from './graphDatabase.js';
// ---- Tree-sitter parser (Phase 2) ------------------------------------------
export { getLanguageConfig, getSupportedExtensions } from './treeSitterLanguageConfigs.js';
export { TreeSitterParser } from './treeSitterParser.js';
// ---- Indexing pipeline (Phase 3) --------------------------------------------
export { IndexingPipeline } from './indexingPipeline.js';
// ---- Query engines (Phase 5) ------------------------------------------------
export { CypherEngine } from './cypherEngine.js';
export { QueryEngine } from './queryEngine.js';
export { createGraphMcpTools } from './mcpToolHandlers.js';
// ---- Auto-sync watcher (Phase 7) --------------------------------------------
export { AutoSyncWatcher } from './autoSync.js';
//# sourceMappingURL=lib.js.map
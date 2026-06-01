/**
 * graphControllerCompatRegistry.ts — Module-level singleton and multi-root
 * functions that mirror the System 1 graphControllerSupport.ts API surface,
 * but delegate acquire/release to the System 2 registry.
 *
 * Phase B only: dormant until Phase C wires it into mainStartup.ts.
 */
import type { CypherEngine } from './cypherEngine';
import { GraphControllerCompat } from './graphControllerCompat';
import type { GraphDatabase } from './graphDatabase';
import type { IndexingWorkerClient } from './indexingWorkerClient';
import type { QueryEngine } from './queryEngine';
export interface RegistryDeps {
    db: GraphDatabase;
    buildQueryEngine: (projectName: string, projectRoot: string) => QueryEngine;
    buildCypherEngine: (projectName: string) => CypherEngine;
    workerClient: IndexingWorkerClient;
    /** Called after a NEW root is acquired. Fire-and-forget async indexing. */
    ensureIndexed: (projectName: string, projectRoot: string) => void;
}
/** Called once at startup (Phase C) to inject shared System 2 instances. */
export declare function initCompatRegistry(deps: RegistryDeps): void;
/** Returns the default-root compat instance, or null if not yet acquired. */
export declare function getGraphController(): GraphControllerCompat | null;
/** Override the default-root compat instance directly (e.g., for testing). */
export declare function setGraphController(compat: GraphControllerCompat | null): void;
/** Get the compat instance for a specific root. Returns null if not acquired. */
export declare function getGraphControllerForRoot(root: string): GraphControllerCompat | null;
/**
 * Acquire a GraphControllerCompat for root. Creates and starts the System 2
 * watcher (via systemTwoRegistry.acquire) and wraps the handle in a compat
 * instance. Increments System 2 refcount on repeat calls.
 *
 * Requires initCompatRegistry() to have been called first.
 */
export declare function acquireGraphController(root: string, pipeline: import('./indexingPipeline').IndexingPipeline): Promise<GraphControllerCompat>;
/**
 * Release a previously acquired root. Delegates to systemTwoRegistry.release.
 * Removes the compat instance from the local map and calls dispose() so
 * resources are freed. No-op if root was never acquired.
 */
export declare function releaseGraphController(root: string): Promise<void>;
/** Dispose all compat instances and clear the local map. Call on app shutdown. */
export declare function disposeAllCompat(): Promise<void>;
//# sourceMappingURL=graphControllerCompatRegistry.d.ts.map
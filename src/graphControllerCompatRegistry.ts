/**
 * graphControllerCompatRegistry.ts — Module-level singleton and multi-root
 * functions that mirror the System 1 graphControllerSupport.ts API surface,
 * but delegate acquire/release to the System 2 registry.
 *
 * Phase B only: dormant until Phase C wires it into mainStartup.ts.
 */

import { consoleErrorLogger as log } from './loggerInterface';
import type { CypherEngine } from './cypherEngine';
import type { CompatHandle } from './graphControllerCompat';
import { GraphControllerCompat } from './graphControllerCompat';
import type { GraphDatabase } from './graphDatabase';
import type { IndexingWorkerClient } from './indexingWorkerClient';
import type { QueryEngine } from './queryEngine';
import * as systemTwoRegistry from './systemTwoRegistry';

// ─── Dependencies injected at startup ────────────────────────────────────────

export interface RegistryDeps {
  db: GraphDatabase;
  buildQueryEngine: (projectName: string, projectRoot: string) => QueryEngine;
  buildCypherEngine: (projectName: string) => CypherEngine;
  workerClient: IndexingWorkerClient;
  /** Called after a NEW root is acquired. Fire-and-forget async indexing. */
  ensureIndexed: (projectName: string, projectRoot: string) => void;
}

let _deps: RegistryDeps | null = null;

/** Called once at startup (Phase C) to inject shared System 2 instances. */
export function initCompatRegistry(deps: RegistryDeps): void {
  _deps = deps;
}

// ─── Per-root compat instance map ────────────────────────────────────────────

const compatMap = new Map<string, GraphControllerCompat>();
let _defaultRoot: string | null = null;

function normalizeRoot(root: string): string {
  return systemTwoRegistry.normalizeRoot(root);
}

// ─── Singleton (default-root) API ────────────────────────────────────────────

/** Returns the default-root compat instance, or null if not yet acquired. */
export function getGraphController(): GraphControllerCompat | null {
  if (_defaultRoot) return compatMap.get(_defaultRoot) ?? null;
  const first = compatMap.values().next();
  return first.done ? null : first.value;
}

/** Override the default-root compat instance directly (e.g., for testing). */
export function setGraphController(compat: GraphControllerCompat | null): void {
  if (!compat) {
    // Remove the current default entry entirely so the map fallback returns null
    if (_defaultRoot) compatMap.delete(_defaultRoot);
    _defaultRoot = null;
    return;
  }
  const key = normalizeRoot(compat.rootPath);
  _defaultRoot = key;
  compatMap.set(key, compat);
}

/** Get the compat instance for a specific root. Returns null if not acquired. */
export function getGraphControllerForRoot(root: string): GraphControllerCompat | null {
  return compatMap.get(normalizeRoot(root)) ?? null;
}

// ─── Acquire / release ────────────────────────────────────────────────────────

/**
 * Acquire a GraphControllerCompat for root. Creates and starts the System 2
 * watcher (via systemTwoRegistry.acquire) and wraps the handle in a compat
 * instance. Increments System 2 refcount on repeat calls.
 *
 * Requires initCompatRegistry() to have been called first.
 */
export async function acquireGraphController(
  root: string,
  pipeline: import('./indexingPipeline').IndexingPipeline,
): Promise<GraphControllerCompat> {
  if (!_deps) throw new Error('[compat-registry] initCompatRegistry() not called');

  const key = normalizeRoot(root);
  const existing = compatMap.get(key);
  if (existing) {
    log.info(`[compat-registry] acquire (existing) ${existing.rootPath}`);
    return existing;
  }

  const s2Handle = await systemTwoRegistry.acquire(root, _deps.db, pipeline, _deps.workerClient);

  const handle: CompatHandle = {
    db: _deps.db,
    queryEngine: _deps.buildQueryEngine(s2Handle.projectName, s2Handle.projectRoot),
    cypherEngine: _deps.buildCypherEngine(s2Handle.projectName),
    workerClient: _deps.workerClient,
    watcher: s2Handle.watcher,
    projectRoot: s2Handle.projectRoot,
    projectName: s2Handle.projectName,
  };

  const compat = new GraphControllerCompat(handle);
  compatMap.set(key, compat);

  if (!_defaultRoot) _defaultRoot = key;
  log.info(`[compat-registry] acquired (new) ${s2Handle.projectName}`);
  _deps.ensureIndexed(s2Handle.projectName, s2Handle.projectRoot);
  return compat;
}

/**
 * Release a previously acquired root. Delegates to systemTwoRegistry.release.
 * Removes the compat instance from the local map and calls dispose() so
 * resources are freed. No-op if root was never acquired.
 */
export async function releaseGraphController(root: string): Promise<void> {
  const key = normalizeRoot(root);
  const existing = compatMap.get(key);
  if (!existing) return;

  await systemTwoRegistry.release(root);

  // Only remove from local map if S2 registry fully released (refcount 0).
  // We detect this by checking whether S2 still has a handle after release.
  const stillActive = systemTwoRegistry.getHandle(root) !== null;
  if (!stillActive) {
    await existing.dispose();
    compatMap.delete(key);
    if (_defaultRoot === key) {
      const next = compatMap.keys().next();
      _defaultRoot = next.done ? null : next.value;
    }
    log.info(`[compat-registry] released and disposed ${root}`);
  }
}

/** Dispose all compat instances and clear the local map. Call on app shutdown. */
export async function disposeAllCompat(): Promise<void> {
  for (const compat of compatMap.values()) {
    await compat.dispose();
  }
  compatMap.clear();
  _defaultRoot = null;
  log.info('[compat-registry] disposeAll complete');
}

/**
 * indexingPipelineHeritage.ts — Wave 21 Phase 1: IMPLEMENTS + EXTENDS edge helpers.
 *
 * Extracted from indexingPipelinePasses.ts to keep that file under the 300-line limit.
 * Called by `definitionPass` after the node-phase completes so all FK targets exist.
 *
 * Decision summary (from wave-21-decisions.md):
 *   - Decision 2: edge emission in `definitionPass`, not `enrichmentPass`.
 *   - Decision 4: skip edges whose target_id doesn't resolve in symbolsByName
 *     (mirrors Wave 19 callResolutionPass filterEdges safety net).
 *   - Decision 5: emit both IMPLEMENTS and EXTENDS from the same class_heritage walk.
 */

import { consoleErrorLogger as log } from './loggerInterface';
import type { GraphDatabase } from './graphDatabase';
import type { GraphEdge } from './graphDatabaseTypes';
import type { IndexedFile } from './indexingPipelineTypes';

// ─── Symbol index ─────────────────────────────────────────────────────────────

/**
 * Build a name → qualifiedId[] map covering Class and Interface nodes.
 * IMPLEMENTS targets are Interface nodes; EXTENDS targets are Class nodes.
 * Mirrors callResolutionPass.buildSymbolsByName but scoped to heritage target labels.
 */
export function buildHeritageSymbols(
  db: GraphDatabase,
  projectName: string,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const nodes = db.getNodesByLabel(projectName, 'Class')
    .concat(db.getNodesByLabel(projectName, 'Interface'));
  for (const node of nodes) {
    const ids = map.get(node.name) ?? [];
    ids.push(node.id);
    map.set(node.name, ids);
  }
  return map;
}

// ─── Edge collection ──────────────────────────────────────────────────────────

interface HeritageEmitResult {
  edges: Omit<GraphEdge, 'id'>[];
  extracted: number;
  emitted: number;
  filtered: number;
}

interface ResolveCtx {
  projectName: string;
  symbolsByName: Map<string, string[]>;
  result: HeritageEmitResult;
}

/** Resolve one heritage name and push an edge if found; update counters. */
function resolveHeritageTarget(
  name: string,
  edgeType: 'EXTENDS' | 'IMPLEMENTS',
  sourceQn: string,
  ctx: ResolveCtx,
): void {
  ctx.result.extracted++;
  const targetQn = ctx.symbolsByName.get(name)?.[0];
  if (targetQn) {
    ctx.result.edges.push({ project: ctx.projectName, source_id: sourceQn, target_id: targetQn, type: edgeType, props: {} });
    ctx.result.emitted++;
  } else {
    ctx.result.filtered++;
  }
}

/** Collect heritage edges for one Class definition entry. */
function collectDefHeritage(
  def: { name: string; kind: string; extendsClause?: string | null; implements?: string[] },
  classQn: string,
  ctx: ResolveCtx,
): void {
  if (def.extendsClause) {
    resolveHeritageTarget(def.extendsClause, 'EXTENDS', classQn, ctx);
  }
  for (const ifaceName of def.implements ?? []) {
    resolveHeritageTarget(ifaceName, 'IMPLEMENTS', classQn, ctx);
  }
}

/**
 * Walk indexedFiles for Class-kind definitions with heritage fields, resolve
 * targets via symbolsByName, and return IMPLEMENTS + EXTENDS edges.
 * Skips unresolved targets (Decision 4: mirrors Wave 19 filterEdges pattern).
 */
function collectHeritageEdges(
  indexedFiles: IndexedFile[],
  projectName: string,
  symbolsByName: Map<string, string[]>,
): HeritageEmitResult {
  const result: HeritageEmitResult = { edges: [], extracted: 0, emitted: 0, filtered: 0 };
  const ctx: ResolveCtx = { projectName, symbolsByName, result };
  for (const file of indexedFiles) {
    if (!file.parsed) continue;
    const fileQn = `${projectName}.${file.relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
    for (const def of file.parsed.definitions) {
      if (def.kind !== 'Class') continue;
      collectDefHeritage(def, `${fileQn}.${def.name}`, ctx);
    }
  }
  return result;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Post-node-phase: build symbolsByName from DB, collect IMPLEMENTS+EXTENDS edges,
 * and insert via db.insertEdges. Called by `definitionPass` in both chunked and
 * non-chunked paths after all symbol nodes are committed — guarantees FK safety.
 * Emits `[trace:definitionPass.heritage]` log line per project per index run.
 */
export function emitHeritageEdges(
  db: GraphDatabase,
  projectName: string,
  indexedFiles: IndexedFile[],
): void {
  const symbolsByName = buildHeritageSymbols(db, projectName);
  const { edges, extracted, emitted, filtered } = collectHeritageEdges(indexedFiles, projectName, symbolsByName);
  if (edges.length > 0) db.insertEdges(edges);
  log.info('[trace:definitionPass.heritage]', { projectName, extracted, emitted, filtered });
}

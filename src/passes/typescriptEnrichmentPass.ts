/**
 * typescriptEnrichmentPass.ts — Pass 6: type-aware CALLS/ASYNC_CALLS/TYPEOF_REFERENCES resolution.
 *
 * Supersedes tree-sitter edges with compiler-resolved edges at 0.98 / compiler_api
 * when ts-morph can definitively identify the callee/referenced-type declaration
 * (including barrel re-exports, overloaded names, aliased imports).
 *
 * Design decisions honored:
 *   D1   — Pass 6, after typeofResolutionPass (5.5), before runEnrichmentPasses.
 *   D3   — ts-morph Project may be null (skip flag or no tsconfig) → no-op.
 *   D5.1 — Authoritative-but-guarded supersession: per (source, edgeType),
 *           build resolved target set R; if R non-empty → delete-then-insert;
 *           if R empty → skip delete (don't wipe good tree-sitter edges).
 *   D6   — Regex typeof pass (Pass 5.5) is RETAINED as the fast-path/base layer;
 *           this pass UPGRADES TYPEOF_REFERENCES to the correct target at 0.98.
 *   D7   — Incremental: changed files → refreshFromFileSystem (done in async
 *           pre-step); new files → addSourceFileAtPath (in same pre-step);
 *           deleted/pruned files → tsMorphProject.getSourceFile(path).forget()
 *           (wired in worker's onFilePruned callback, Phase 1). Cross-file
 *           incoming-edge staleness on unchanged files is a documented limitation
 *           cleared by full reindex.
 *
 * TYPEOF_REFERENCES source/target model (mirrors indexingPipelineTypeofResolution.ts):
 *   source_id = fileQn  (whole-file QN — e.g. "project.src.myModule")
 *   target_id = any indexed node QN (Function/Method/Class/Variable/Interface/Type/Enum)
 *               whose name matches the referenced type symbol.
 *   This matches the regex pass's file-level granularity exactly (line 210+224
 *   of indexingPipelineTypeofResolution.ts) so supersession aligns correctly.
 *
 * Stale-node trap:
 *   `sourceFile.refreshFromFileSystem()` forgets all child AST nodes. All
 *   per-file navigation MUST happen AFTER the refresh, never before.
 *   Do not cache any AST node references across the refresh boundary.
 *
 * Incremental limitation (documented, not a bug):
 *   Only files in `indexedFiles` (the changed set) are re-resolved. Edges
 *   from unchanged files into a changed file are not re-resolved. Cleared by
 *   full reindex.
 */

import { consoleErrorLogger as log } from '../loggerInterface';
import type { GraphDatabase } from '../graphDatabase';
import type { GraphEdge } from '../graphDatabaseTypes';
import type { IndexedFile } from '../indexingPipelineTypes';
import { Project, ts } from 'ts-morph';

// ─── Constants ────────────────────────────────────────────────────────────────

const COMPILER_API_CONFIDENCE = 0.98;
const RESOLUTION_METHOD = 'compiler_api';
const TS_EXTENSIONS = new Set(['ts', 'tsx']);

// ─── QN builders (mirror indexingPipelineCallResolution + TypeofResolution) ──

/**
 * Build the whole-file qualified-name.
 * Scheme: `${projectName}.${relativePath.replace(/\//g,'.').replace(/\.[^.]+$/,'')}`
 * Mirrors indexingPipelineCallResolution.ts:140 and
 * indexingPipelineTypeofResolution.ts:185.
 *
 * Exported so referencesPass.ts can reuse without duplication.
 */
export function buildFileQn(projectName: string, relativePath: string): string {
  return `${projectName}.${relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
}

/**
 * Build the qualified-name for a named symbol inside a file.
 * Scheme: `${fileQn}.${symbolName}`
 *
 * Exported so referencesPass.ts can reuse without duplication.
 */
export function buildSymbolQn(fileQn: string, symbolName: string): string {
  return `${fileQn}.${symbolName}`;
}

// ─── validNodeIds builders ────────────────────────────────────────────────────

/**
 * Build the set of valid node IDs for CALLS/ASYNC_CALLS resolution.
 * Mirrors callResolutionPass validNodeIds: Function + Method + Class only.
 */
function buildCallValidNodeIds(db: GraphDatabase, projectName: string): Set<string> {
  const all = db
    .getNodesByLabel(projectName, 'Function')
    .concat(db.getNodesByLabel(projectName, 'Method'))
    .concat(db.getNodesByLabel(projectName, 'Class'));
  return new Set(all.map((n) => n.id));
}

/**
 * Build the set of valid node IDs for TYPEOF_REFERENCES resolution.
 * Mirrors the typeof regex pass's symbolsByName builder: Function + Method +
 * Class + Variable + Interface + Type + Enum (all the typeof-referenceable labels).
 * See indexingPipelineTypeofResolution.ts:284-292.
 */
function buildTypeofValidNodeIds(db: GraphDatabase, projectName: string): Set<string> {
  const all = db
    .getNodesByLabel(projectName, 'Function')
    .concat(db.getNodesByLabel(projectName, 'Method'))
    .concat(db.getNodesByLabel(projectName, 'Class'))
    .concat(db.getNodesByLabel(projectName, 'Variable'))
    .concat(db.getNodesByLabel(projectName, 'Interface'))
    .concat(db.getNodesByLabel(projectName, 'Type'))
    .concat(db.getNodesByLabel(projectName, 'Enum'));
  return new Set(all.map((n) => n.id));
}

// ─── absoluteToRelative ───────────────────────────────────────────────────────

/**
 * Given an absolute file path (forward slashes from ts-morph) and the project
 * root (may use backslashes on Windows), return the relative path with forward
 * slashes, or null if the file is outside the project.
 *
 * Case-insensitive prefix comparison handles Windows drive-letter case
 * differences (C:/ vs c:/) between ts-morph's getFilePath() and projectRoot.
 * Slices from the original normFile to preserve real casing in the result.
 *
 * Exported so referencesPass.ts can reuse without duplication.
 */
export function absoluteToRelative(
  absoluteFilePath: string,
  projectRoot: string,
): string | null {
  const normFile = absoluteFilePath.replace(/\\/g, '/');
  const normRoot = projectRoot.replace(/\\/g, '/').replace(/\/?$/, '/');
  if (!normFile.toLowerCase().startsWith(normRoot.toLowerCase())) return null;
  return normFile.slice(normRoot.length);
}

// ─── Callee resolution via ts-morph (for CALLS/ASYNC_CALLS) ─────────────────

/**
 * Given a ts-morph CallExpression, resolve the canonical declaration of the
 * callee (following aliases and barrel re-exports).
 *
 * Returns { filePath, symbolName } where filePath is the forward-slash absolute
 * path to the file containing the real definition, or null if unresolvable.
 *
 * Resolution strategy (ordered by reliability):
 *   1. getResolvedSignature() → getDeclaration()  — direct call typing
 *   2. callee expression symbol → getAliasedSymbol() → declarations[0]  — barrels/re-exports
 *   3. fallback: same symbol path without strategy-1 signature gate
 */
function resolveCalleeDeclaration(
  project: Project,
  callExpr: import('ts-morph').CallExpression,
): { filePath: string; symbolName: string } | null {
  // Strategy 1: resolved signature
  try {
    const tc = project.getTypeChecker();
    const sig = tc.getResolvedSignature(callExpr);
    const decl = sig?.getDeclaration();
    if (decl) {
      const sym = decl.getSymbol?.();
      const symbolName = sym?.getName() ?? null;
      if (symbolName && symbolName !== '__function' && symbolName !== '__type') {
        const filePath = decl.getSourceFile().getFilePath().replace(/\\/g, '/');
        return { filePath, symbolName };
      }
    }
  } catch {
    // fall through
  }

  // Strategy 2: callee symbol → aliased symbol → declarations
  try {
    const expr = callExpr.getExpression();
    const nameExpr =
      ts.isPropertyAccessExpression(expr.compilerNode)
        ? (expr as import('ts-morph').PropertyAccessExpression).getNameNode()
        : expr;

    const sym = nameExpr.getSymbol();
    if (sym) {
      const aliased = sym.getAliasedSymbol() ?? sym;
      const decls = aliased.getDeclarations();
      if (decls.length > 0) {
        const symbolName = aliased.getName();
        if (symbolName && symbolName !== '__function' && symbolName !== '__type') {
          const filePath = decls[0].getSourceFile().getFilePath().replace(/\\/g, '/');
          return { filePath, symbolName };
        }
      }
    }
  } catch {
    // fall through
  }

  // Strategy 3: fallback via symbol declarations
  try {
    const expr = callExpr.getExpression();
    const nameExpr =
      ts.isPropertyAccessExpression(expr.compilerNode)
        ? (expr as import('ts-morph').PropertyAccessExpression).getNameNode()
        : expr;

    const sym3 = nameExpr.getSymbol();
    if (sym3) {
      const target3 = sym3.getAliasedSymbol() ?? sym3;
      const decls3 = target3.getDeclarations();
      if (decls3.length > 0) {
        const sym3Name = target3.getName();
        if (sym3Name && sym3Name !== '__function' && sym3Name !== '__type') {
          const filePath = decls3[0].getSourceFile().getFilePath().replace(/\\/g, '/');
          return { filePath, symbolName: sym3Name };
        }
      }
    }
  } catch {
    // all strategies failed
  }

  return null;
}

// ─── Referenced type resolution via ts-morph (for TYPEOF_REFERENCES) ─────────

/**
 * Given a TypeQueryNode (`typeof X` in type position), resolve the canonical
 * declaration of the referenced symbol (following aliases and barrel re-exports).
 *
 * TypeQueryNode is the ts-morph wrapper for `typeof expr` in a type position.
 * Its `getExprName()` returns the Identifier (or QualifiedName) of the symbol.
 *
 * Returns { filePath, symbolName } or null if unresolvable.
 * Does NOT need the Project reference — symbol resolution uses the node's own
 * type-checker binding.
 */
function resolveTypeQueryDeclaration(
  typeQuery: import('ts-morph').TypeQueryNode,
): { filePath: string; symbolName: string } | null {
  try {
    const exprName = typeQuery.getExprName();
    const sym = exprName.getSymbol();
    if (!sym) return null;

    const aliased = sym.getAliasedSymbol() ?? sym;
    const decls = aliased.getDeclarations();
    if (decls.length === 0) return null;

    const symbolName = aliased.getName();
    if (!symbolName || symbolName === '__function' || symbolName === '__type') return null;

    const filePath = decls[0].getSourceFile().getFilePath().replace(/\\/g, '/');
    return { filePath, symbolName };
  } catch {
    return null;
  }
}

// ─── Enclosing-function name resolution ──────────────────────────────────────

/**
 * Walk the ancestor chain of a node to find the nearest enclosing named
 * function or method and return its name. Returns null if none found.
 *
 * Mirrors the tree-sitter pass's enclosingDef lookup so caller QN aligns.
 *
 * Exported so referencesPass.ts can reuse without duplication.
 */
export function getEnclosingFunctionName(node: import('ts-morph').Node): string | null {
  let current: import('ts-morph').Node | undefined = node.getParent();

  while (current) {
    const kind = current.getKind();

    if (
      kind === ts.SyntaxKind.FunctionDeclaration ||
      kind === ts.SyntaxKind.FunctionExpression
    ) {
      const n = current as import('ts-morph').FunctionDeclaration;
      const name = n.getName?.();
      if (name) return name;
    }

    if (kind === ts.SyntaxKind.MethodDeclaration) {
      const n = current as import('ts-morph').MethodDeclaration;
      const name = n.getName?.();
      if (name) return name;
    }

    if (kind === ts.SyntaxKind.Constructor) {
      return 'constructor';
    }

    if (kind === ts.SyntaxKind.ArrowFunction) {
      const parent = current.getParent();
      if (parent?.getKind() === ts.SyntaxKind.VariableDeclaration) {
        const vd = parent as import('ts-morph').VariableDeclaration;
        const name = vd.getName?.();
        if (name) return name;
      }
    }

    current = current.getParent();
  }

  return null;
}

// ─── ResolvedEdge (generalised — covers all three edge types) ─────────────────

interface ResolvedEdge {
  /** source_id QN — fileQn for TYPEOF_REFERENCES; callerQn for CALLS/ASYNC_CALLS */
  sourceQn: string;
  targetQn: string;
  edgeType: 'CALLS' | 'ASYNC_CALLS' | 'TYPEOF_REFERENCES';
}

// ─── CALLS / ASYNC_CALLS resolution per file ──────────────────────────────────

function resolveCallEdges(
  sourceFile: import('ts-morph').SourceFile,
  projectName: string,
  projectRoot: string,
  fileQn: string,
  callValidNodeIds: Set<string>,
  project: Project,
): ResolvedEdge[] {
  const edges: ResolvedEdge[] = [];
  const callExprs = sourceFile.getDescendantsOfKind(ts.SyntaxKind.CallExpression);

  for (const callExpr of callExprs) {
    const enclosingName = getEnclosingFunctionName(callExpr);
    if (!enclosingName) continue;

    const callerQn = buildSymbolQn(fileQn, enclosingName);
    if (!callValidNodeIds.has(callerQn)) continue;

    const resolved = resolveCalleeDeclaration(project, callExpr);
    if (!resolved) continue;

    const relPath = absoluteToRelative(resolved.filePath, projectRoot);
    if (!relPath) continue;

    const calleeFileQn = buildFileQn(projectName, relPath);
    const calleeQn = buildSymbolQn(calleeFileQn, resolved.symbolName);
    if (!callValidNodeIds.has(calleeQn)) continue;
    if (calleeQn === callerQn) continue;

    const isAsync = callExpr.getParent()?.getKind() === ts.SyntaxKind.AwaitExpression;
    const edgeType: 'CALLS' | 'ASYNC_CALLS' = isAsync ? 'ASYNC_CALLS' : 'CALLS';

    edges.push({ sourceQn: callerQn, targetQn: calleeQn, edgeType });
  }

  return edges;
}

// ─── TYPEOF_REFERENCES resolution per file ────────────────────────────────────

/**
 * Enumerate all TypeQuery (`typeof X`) nodes in a source file and resolve each
 * to the canonical type definition, emitting TYPEOF_REFERENCES edges.
 *
 * Source model: source_id = fileQn (whole-file QN).
 * This matches the regex pass exactly (indexingPipelineTypeofResolution.ts:210,224).
 *
 * The supersession key for D5.1 is therefore (fileQn, 'TYPEOF_REFERENCES') —
 * one delete-then-insert per file when R is non-empty.
 */
function resolveTypeofEdges(
  sourceFile: import('ts-morph').SourceFile,
  projectName: string,
  projectRoot: string,
  fileQn: string,
  typeofValidNodeIds: Set<string>,
): ResolvedEdge[] {
  const edges: ResolvedEdge[] = [];
  // TypeQuery is the AST node for `typeof X` in a type position.
  // It covers all 6 patterns the regex pass handles:
  //   typeof X, ReturnType<typeof X>, Parameters<typeof X>,
  //   InstanceType<typeof X>, Awaited<ReturnType<typeof X>>, keyof typeof X
  const typeQueries = sourceFile.getDescendantsOfKind(ts.SyntaxKind.TypeQuery);

  for (const typeQuery of typeQueries) {
    const resolved = resolveTypeQueryDeclaration(typeQuery);
    if (!resolved) continue;

    const relPath = absoluteToRelative(resolved.filePath, projectRoot);
    if (!relPath) continue;

    const targetFileQn = buildFileQn(projectName, relPath);
    const targetQn = buildSymbolQn(targetFileQn, resolved.symbolName);
    if (!typeofValidNodeIds.has(targetQn)) continue;
    if (targetQn === fileQn) continue; // skip self-reference

    edges.push({ sourceQn: fileQn, targetQn, edgeType: 'TYPEOF_REFERENCES' });
  }

  return edges;
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function deduplicateEdges(edges: ResolvedEdge[]): ResolvedEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.sourceQn}|${e.targetQn}|${e.edgeType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── D5.1 supersession grouping ──────────────────────────────────────────────

/**
 * Group resolved edges by (sourceQn, edgeType) for D5.1 delete-then-insert.
 * For CALLS/ASYNC_CALLS: sourceQn is callerQn (function-level).
 * For TYPEOF_REFERENCES: sourceQn is fileQn (file-level).
 */
function groupBySourceAndType(edges: ResolvedEdge[]): Map<string, ResolvedEdge[]> {
  const groups = new Map<string, ResolvedEdge[]>();
  for (const edge of edges) {
    const key = `${edge.sourceQn}||${edge.edgeType}`;
    const group = groups.get(key) ?? [];
    group.push(edge);
    groups.set(key, group);
  }
  return groups;
}

// ─── Public: typescriptEnrichmentPass ────────────────────────────────────────

export interface TsEnrichmentPassOptions {
  /**
   * The ts-morph Project singleton from the worker, or null when:
   *  - skipTsEnrichment is set
   *  - no tsconfig.json exists at projectRoot
   *  - the Project constructor previously threw (tsMorphProjectFailed)
   */
  tsMorphProject: Project | null;
}

/**
 * Pass 6 — ts-morph type-aware CALLS/ASYNC_CALLS/TYPEOF_REFERENCES resolution.
 *
 * Signature mirrors typeofResolutionPass (Pass 5.5) plus a tsMorphProject param.
 * The pipeline threads the Project from the worker singleton.
 *
 * When tsMorphProject is null → immediate no-op (D3/D4 skip paths).
 *
 * Incremental wiring (D7):
 *   changed files → refreshFromFileSystem() in async pre-step (below)
 *   new files     → addSourceFileAtPath() in async pre-step (below)
 *   deleted files → worker's onFilePruned callback calls getSourceFile().forget()
 *                   (wired in indexingWorker.ts handleIndexRepository, Phase 1)
 */
export async function typescriptEnrichmentPass(
  db: GraphDatabase,
  projectName: string,
  projectRoot: string,
  indexedFiles: IndexedFile[],
  options: TsEnrichmentPassOptions,
): Promise<void> {
  const { tsMorphProject } = options;

  // D3/D4: null Project → no-op
  if (!tsMorphProject) return;

  // Scope to TS/TSX files only (D1)
  const tsFiles = indexedFiles.filter((f) => TS_EXTENSIONS.has(f.extension));
  if (tsFiles.length === 0) return;

  // Build node-ID sets — separate sets for the two resolution domains
  const callValidNodeIds = buildCallValidNodeIds(db, projectName);
  const typeofValidNodeIds = buildTypeofValidNodeIds(db, projectName);

  // Both sets empty means nothing to resolve
  if (callValidNodeIds.size === 0 && typeofValidNodeIds.size === 0) return;

  // ── Async pre-step (D7): refresh / add all in-scope source files ──────────
  // MUST run OUTSIDE any transaction and BEFORE any AST navigation.
  // refreshFromFileSystem() forgets all child nodes — re-navigate after.
  const sourceFileMap = new Map<string, import('ts-morph').SourceFile>();

  for (const file of tsFiles) {
    // Normalise to forward slashes for ts-morph lookup on all platforms
    const absPath = file.absolutePath.replace(/\\/g, '/');
    let sf = tsMorphProject.getSourceFile(absPath);
    if (!sf) {
      // New file not yet in the Project (D7 add path) — register it
      try {
        sf = tsMorphProject.addSourceFileAtPath(file.absolutePath);
      } catch (err) {
        log.warn(
          '[trace:tsEnrich] addSourceFileAtPath failed file=%s: %s',
          file.relativePath,
          err instanceof Error ? err.message : String(err),
        );
        continue;
      }
    }
    // Changed file (D7 warm incremental) — sync AST from disk
    try {
      await sf.refreshFromFileSystem();
    } catch (err) {
      log.warn(
        '[trace:tsEnrich] refreshFromFileSystem failed file=%s: %s',
        file.relativePath,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    sourceFileMap.set(file.relativePath, sf);
  }

  // ── Synchronous upgrade loop ──────────────────────────────────────────────
  // Per file: resolve both CALLS/ASYNC_CALLS and TYPEOF_REFERENCES edges.
  // D5.1: per (sourceQn, edgeType) → if R non-empty → delete-then-insert;
  //        if R empty → skip (preserve tree-sitter edges).

  for (const file of tsFiles) {
    const sf = sourceFileMap.get(file.relativePath);
    if (!sf) continue;

    const fileQn = buildFileQn(projectName, file.relativePath);

    // Collect all resolved edges for this file (CALLS, ASYNC_CALLS, TYPEOF_REFERENCES)
    let fileEdges: ResolvedEdge[];
    try {
      const callEdges = callValidNodeIds.size > 0
        ? resolveCallEdges(sf, projectName, projectRoot, fileQn, callValidNodeIds, tsMorphProject)
        : [];
      const typeofEdges = typeofValidNodeIds.size > 0
        ? resolveTypeofEdges(sf, projectName, projectRoot, fileQn, typeofValidNodeIds)
        : [];
      fileEdges = [...callEdges, ...typeofEdges];
    } catch (err) {
      log.warn(
        '[trace:tsEnrich] resolution failed file=%s: %s',
        file.relativePath,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }

    const deduped = deduplicateEdges(fileEdges);
    if (deduped.length === 0) continue;

    // Group by (sourceQn, edgeType) for D5.1 supersession
    const groups = groupBySourceAndType(deduped);

    db.transaction(() => {
      for (const [, groupEdges] of groups) {
        const { sourceQn, edgeType } = groupEdges[0];

        // R non-empty → delete all outbound edges of this type from this source,
        // then insert the compiler-resolved set at 0.98 / compiler_api
        db.deleteOutboundEdgesOfType(projectName, sourceQn, edgeType);

        const toInsert: Omit<GraphEdge, 'id'>[] = groupEdges.map((e) => ({
          project: projectName,
          source_id: e.sourceQn,
          target_id: e.targetQn,
          type: e.edgeType,
          props: { resolution_method: RESOLUTION_METHOD },
          confidence: COMPILER_API_CONFIDENCE,
        }));

        db.insertEdges(toInsert);
      }
    });

    log.info(
      '[trace:tsEnrich] file=%s resolved=%d edges (groups=%d)',
      file.relativePath,
      deduped.length,
      groups.size,
    );
  }
}

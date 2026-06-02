/**
 * typescriptEnrichmentPass.ts — Pass 6: type-aware CALLS/ASYNC_CALLS resolution.
 *
 * Supersedes tree-sitter CALLS/ASYNC_CALLS edges with compiler-resolved edges
 * at confidence 0.98 / resolution_method 'compiler_api' when ts-morph can
 * definitively identify the callee declaration (including barrel re-exports,
 * overloaded names, and aliased imports that the tree-sitter heuristics drop).
 *
 * Design decisions honored:
 *   D1  — Pass 6, after typeofResolutionPass (5.5), before runEnrichmentPasses.
 *   D3  — ts-morph Project may be null (skip flag or no tsconfig) → no-op.
 *   D5.1 — Authoritative-but-guarded supersession: per (caller, edgeType),
 *           build resolved target set R; if R non-empty → delete-then-insert;
 *           if R empty → skip delete (don't wipe good tree-sitter edges).
 *   D6  — TYPEOF_REFERENCES upgrade is Phase 3; this pass handles CALLS and
 *           ASYNC_CALLS only.
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

// ─── QN builder (mirrors indexingPipelineCallResolution) ─────────────────────

/**
 * Build the qualified-name for a file-level context.
 * Scheme: `${projectName}.${relativePath.replace(/\//g,'.').replace(/\.[^.]+$/,'')}`
 * Mirrors the scheme in indexingPipelineCallResolution.ts:140 and
 * indexingPipelineTypeofResolution.ts:184.
 */
function buildFileQn(projectName: string, relativePath: string): string {
  return `${projectName}.${relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
}

/**
 * Build the qualified-name for a named symbol inside a file.
 * Scheme: `${fileQn}.${symbolName}`
 */
function buildSymbolQn(fileQn: string, symbolName: string): string {
  return `${fileQn}.${symbolName}`;
}

// ─── Callee resolution via ts-morph ──────────────────────────────────────────

/**
 * Given a ts-morph Project and a call-expression node, resolve the canonical
 * declaration of the callee (following aliases and barrel re-exports).
 *
 * Returns { filePath, symbolName } where filePath is the FORWARD-SLASH absolute
 * path to the file containing the real definition (ts-morph always returns
 * forward slashes even on Windows), or null if resolution fails.
 *
 * Resolution strategy (ordered by reliability):
 *   1. getResolvedSignature() → getDeclaration()  — direct call typing
 *   2. callee expression symbol → getAliasedSymbol() → declarations[0]  — barrels/re-exports
 *   3. callee expression → getDefinitionNodes()[0]  — fallback
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
      // Use the symbol's name rather than the name node to avoid TS union type issues
      const sym = decl.getSymbol?.();
      const symbolName = sym?.getName() ?? null;
      if (symbolName && symbolName !== '__function' && symbolName !== '__type') {
        const filePath = decl.getSourceFile().getFilePath().replace(/\\/g, '/');
        return { filePath, symbolName };
      }
    }
  } catch {
    // Strategy 1 failed — fall through
  }

  // Strategy 2: callee symbol → aliased symbol → declarations
  try {
    const expr = callExpr.getExpression();
    // For member access (a.b()), get the rightmost name part
    const nameExpr =
      ts.isPropertyAccessExpression(expr.compilerNode)
        ? (expr as import('ts-morph').PropertyAccessExpression).getNameNode()
        : expr;

    const sym = nameExpr.getSymbol();
    if (sym) {
      const aliased = sym.getAliasedSymbol() ?? sym;
      const decls = aliased.getDeclarations();
      if (decls.length > 0) {
        const decl = decls[0];
        const symbolName = aliased.getName();
        if (symbolName && symbolName !== '__function' && symbolName !== '__type') {
          const filePath = decl.getSourceFile().getFilePath().replace(/\\/g, '/');
          return { filePath, symbolName };
        }
      }
    }
  } catch {
    // Strategy 2 failed — fall through
  }

  // Strategy 3: symbol declarations fallback
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
        const decl3 = decls3[0];
        const sym3Name = target3.getName();
        if (sym3Name && sym3Name !== '__function' && sym3Name !== '__type') {
          const filePath = decl3.getSourceFile().getFilePath().replace(/\\/g, '/');
          return { filePath, symbolName: sym3Name };
        }
      }
    }
  } catch {
    // All strategies failed
  }

  return null;
}

// ─── Enclosing-function name resolution ──────────────────────────────────────

/**
 * Walk the ancestor chain of a node to find the nearest enclosing function
 * or method and return its name. Returns null if no named enclosing function
 * is found.
 *
 * Mirrors the tree-sitter pass's enclosingDef lookup (indexingPipelineCallResolution.ts:148):
 * the name must match so the caller QN aligns with the indexed node's QN.
 *
 * Handles:
 *   - FunctionDeclaration / FunctionExpression (named)
 *   - MethodDeclaration
 *   - ArrowFunction assigned to a named VariableDeclaration
 *   - ConstructorDeclaration (name = 'constructor')
 */
function getEnclosingFunctionName(node: import('ts-morph').Node): string | null {
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
      // Arrow function: check if it's assigned to a named const
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

// ─── validNodeIds builder (mirrors callResolutionPass) ───────────────────────

function buildValidNodeIds(db: GraphDatabase, projectName: string): Set<string> {
  const all = db
    .getNodesByLabel(projectName, 'Function')
    .concat(db.getNodesByLabel(projectName, 'Method'))
    .concat(db.getNodesByLabel(projectName, 'Class'));
  return new Set(all.map((n) => n.id));
}

// ─── Map an absolute file path to the project-relative path for QN building ──

/**
 * Given an absolute file path (forward slashes from ts-morph) and the project
 * root (may use backslashes on Windows), return the relative path with forward
 * slashes, or null if the file is outside the project.
 */
function absoluteToRelative(
  absoluteFilePath: string,
  projectRoot: string,
): string | null {
  // Normalise both to forward slashes for cross-platform comparison.
  // Drive-letter case on Windows (C:/ vs c:/) can differ between ts-morph's
  // getFilePath() and options.projectRoot — compare lowercased prefixes but
  // slice from the original normFile to preserve real casing in the result.
  const normFile = absoluteFilePath.replace(/\\/g, '/');
  const normRoot = projectRoot.replace(/\\/g, '/').replace(/\/?$/, '/');
  if (!normFile.toLowerCase().startsWith(normRoot.toLowerCase())) return null;
  return normFile.slice(normRoot.length);
}

// ─── Per-file resolution logic ───────────────────────────────────────────────

interface ResolvedEdge {
  callerQn: string;
  calleeQn: string;
  edgeType: 'CALLS' | 'ASYNC_CALLS';
}

/**
 * For one source file, enumerate all call expressions, resolve each via
 * ts-morph, and return the set of edges that:
 *  - have both caller and callee in validNodeIds
 *  - map to an indexed project file
 */
function resolveFileEdges(
  sourceFile: import('ts-morph').SourceFile,
  projectName: string,
  projectRoot: string,
  fileQn: string,
  validNodeIds: Set<string>,
  project: Project,
): ResolvedEdge[] {
  const edges: ResolvedEdge[] = [];
  // NOTE: All navigation happens AFTER refreshFromFileSystem (stale-node trap).
  // Re-get descendants from the SourceFile after refresh.
  const callExprs = sourceFile.getDescendantsOfKind(ts.SyntaxKind.CallExpression);

  for (const callExpr of callExprs) {
    const enclosingName = getEnclosingFunctionName(callExpr);
    if (!enclosingName) continue;

    const callerQn = buildSymbolQn(fileQn, enclosingName);
    if (!validNodeIds.has(callerQn)) continue;

    const resolved = resolveCalleeDeclaration(project, callExpr);
    if (!resolved) continue;

    const relPath = absoluteToRelative(resolved.filePath, projectRoot);
    if (!relPath) continue; // callee is outside the project

    const calleeFileQn = buildFileQn(projectName, relPath);
    const calleeQn = buildSymbolQn(calleeFileQn, resolved.symbolName);
    if (!validNodeIds.has(calleeQn)) continue;
    if (calleeQn === callerQn) continue; // skip self-calls

    // Determine CALLS vs ASYNC_CALLS: check if the CallExpression is awaited
    const isAsync = callExpr.getParent()?.getKind() === ts.SyntaxKind.AwaitExpression;
    const edgeType: 'CALLS' | 'ASYNC_CALLS' = isAsync ? 'ASYNC_CALLS' : 'CALLS';

    edges.push({ callerQn, calleeQn, edgeType });
  }

  return edges;
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function deduplicateResolvedEdges(edges: ResolvedEdge[]): ResolvedEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.callerQn}|${e.calleeQn}|${e.edgeType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── D5.1 supersession: group edges by (caller, edgeType) ────────────────────

function groupEdgesByCallerAndType(
  edges: ResolvedEdge[],
): Map<string, ResolvedEdge[]> {
  const groups = new Map<string, ResolvedEdge[]>();
  for (const edge of edges) {
    const key = `${edge.callerQn}||${edge.edgeType}`;
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
 * Pass 6 — ts-morph type-aware CALLS/ASYNC_CALLS resolution.
 *
 * Signature mirrors typeofResolutionPass (Pass 5.5) plus a tsMorphProject
 * param. The pipeline threads the Project from the worker singleton.
 *
 * When tsMorphProject is null → immediate no-op (D3/D4 skip paths).
 */
export async function typescriptEnrichmentPass(
  db: GraphDatabase,
  projectName: string,
  projectRoot: string,
  indexedFiles: IndexedFile[],
  options: TsEnrichmentPassOptions,
): Promise<void> {
  const { tsMorphProject } = options;

  // D3/D4: null Project → no-op (skip flag, no tsconfig, or prior failure)
  if (!tsMorphProject) return;

  // Scope to TS/TSX files only (D1)
  const tsFiles = indexedFiles.filter((f) => TS_EXTENSIONS.has(f.extension));
  if (tsFiles.length === 0) return;

  // Build validNodeIds (mirrors callResolutionPass:223)
  const validNodeIds = buildValidNodeIds(db, projectName);
  if (validNodeIds.size === 0) return;

  // ── Async pre-step: refresh all in-scope source files from disk ───────────
  // MUST be done OUTSIDE any transaction and BEFORE any AST navigation.
  // refreshFromFileSystem() forgets all child nodes — re-navigate after.
  const sourceFileMap = new Map<string, import('ts-morph').SourceFile>();

  for (const file of tsFiles) {
    // Normalise to forward slashes for ts-morph lookup (works on both platforms)
    const absPath = file.absolutePath.replace(/\\/g, '/');
    let sf = tsMorphProject.getSourceFile(absPath);
    if (!sf) {
      // File not yet tracked by this Project (added after init) — add it
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
  // Per file, per (caller, edgeType): resolve call sites via ts-morph.
  // D5.1: if R non-empty → delete-then-insert; if R empty → skip.

  for (const file of tsFiles) {
    const sf = sourceFileMap.get(file.relativePath);
    if (!sf) continue;

    const fileQn = buildFileQn(projectName, file.relativePath);

    let fileEdges: ResolvedEdge[];
    try {
      fileEdges = resolveFileEdges(sf, projectName, projectRoot, fileQn, validNodeIds, tsMorphProject);
    } catch (err) {
      log.warn(
        '[trace:tsEnrich] resolveFileEdges failed file=%s: %s',
        file.relativePath,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }

    const deduped = deduplicateResolvedEdges(fileEdges);
    if (deduped.length === 0) continue;

    // Group by (caller, edgeType) for D5.1 authoritative-but-guarded supersession
    const groups = groupEdgesByCallerAndType(deduped);

    db.transaction(() => {
      for (const [, groupEdges] of groups) {
        const { callerQn, edgeType } = groupEdges[0];

        // R is non-empty → delete all existing outbound edges of this type from this caller,
        // then insert the compiler-resolved set
        db.deleteOutboundEdgesOfType(projectName, callerQn, edgeType);

        const toInsert: Omit<GraphEdge, 'id'>[] = groupEdges.map((e) => ({
          project: projectName,
          source_id: e.callerQn,
          target_id: e.calleeQn,
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

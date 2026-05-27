/**
 * detectChangesForSessionTypes.ts — Types for detectChangesForSession on GraphDatabase.
 *
 * Mirrors System 1's ChangeDetectionResult shape enriched with session context.
 * Used by Package 2 to expose change detection from the SQLite-backed graph.
 */

// ─── Changed symbol entry ─────────────────────────────────────────────────────

export interface ChangedSymbol {
  /** Node ID (qualified_name) */
  id: string;
  name: string;
  label: string;
  filePath: string | null;
  startLine: number | null;
  /** How many hops from a directly changed file (0 = in changed file, 1-2 = transitive) */
  hopDepth: number;
}

// ─── Session change detection result ─────────────────────────────────────────

export interface ChangedSymbolsForSession {
  /** Project name scoping this result */
  projectName: string;
  /** Files from sessionFiles that had changed mtime or hash */
  changedFiles: string[];
  /** All symbols in changed files + their transitive callers (up to N=2 hops) */
  affectedSymbols: ChangedSymbol[];
  /** Total blast radius (unique symbol count) */
  blastRadius: number;
}

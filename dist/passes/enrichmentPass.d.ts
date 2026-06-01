/**
 * enrichmentPass.ts — Entry point refinement and enrichment pass.
 *
 * Marks additional entry points that the core pipeline may have missed.
 * Entry point heuristics:
 *
 *   - Decorator patterns: Controller, Injectable, Component, etc.
 *   - Index file default exports (barrel re-exports).
 *   - Framework-specific entry points (main, cli, command, route handlers).
 *
 * IMPLEMENTS and EXTENDS edges are emitted from `definitionPass` (since
 * Wave 21) — see indexingPipelinePasses.ts. enrichmentPass remains
 * focused on entry-point heuristics.
 */
import type { GraphDatabase } from '../graphDatabase';
export declare function enrichmentPass(db: GraphDatabase, projectName: string): void;
//# sourceMappingURL=enrichmentPass.d.ts.map
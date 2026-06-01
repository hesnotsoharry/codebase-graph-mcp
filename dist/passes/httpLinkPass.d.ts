/**
 * httpLinkPass.ts — HTTP call-site detection pass.
 *
 * Scans extracted call sites for known HTTP client patterns (fetch, axios,
 * requests, http, httpx, https) and matches them against Route nodes already
 * present in the graph. Creates HTTP_CALLS edges with confidence scores
 * (0.0–1.0) based on normalized URL path + method comparison.
 *
 * Wave 1 Phase 1: matching now uses the actual called URL (extracted at the
 * parser layer into ExtractedCall.firstArgValue) and the real HTTP method
 * (from ExtractedCall.optionsMethod for fetch options, or from the callee verb
 * for axios/requests/httpx). A single best-match edge is emitted per call site
 * (no fan-out). Non-literal URLs fall back to the legacy name-heuristic at
 * low confidence, tagged heuristic_name — never dropped.
 */
import type { GraphDatabase } from '../graphDatabase';
import type { IndexedFile } from './passTypes';
export declare function httpLinkPass(db: GraphDatabase, projectName: string, indexedFiles: IndexedFile[]): void;
//# sourceMappingURL=httpLinkPass.d.ts.map
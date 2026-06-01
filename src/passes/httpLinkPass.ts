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
import type { GraphEdge, GraphNode } from '../graphDatabaseTypes';
import type { ResolutionMethod } from '../graphDatabaseTypes';
import type { IndexedFile } from './passTypes';

// ─── HTTP call-site patterns ─────────────────────────────────────────────────
// Maps a function/method name to the HTTP methods it can represent.
// '*' means any method (the actual method is determined at runtime).

// Map (not Record) — avoids prototype pollution when call names like
// `toString`, `constructor`, `hasOwnProperty` collide with Object.prototype.
const HTTP_CALL_PATTERNS: ReadonlyMap<string, readonly string[]> = new Map([
  // JavaScript / TypeScript
  ['fetch', ['GET']],
  ['axios', ['GET']],
  ['axios.get', ['GET']],
  ['axios.post', ['POST']],
  ['axios.put', ['PUT']],
  ['axios.delete', ['DELETE']],
  ['axios.patch', ['PATCH']],
  // Node.js http / https
  ['http.get', ['GET']],
  ['http.request', ['*']],
  ['https.get', ['GET']],
  ['https.request', ['*']],
  // Python — requests
  ['requests.get', ['GET']],
  ['requests.post', ['POST']],
  ['requests.put', ['PUT']],
  ['requests.delete', ['DELETE']],
  ['requests.patch', ['PATCH']],
  // Python — httpx
  ['httpx.get', ['GET']],
  ['httpx.post', ['POST']],
  ['httpx.put', ['PUT']],
  ['httpx.delete', ['DELETE']],
  ['httpx.patch', ['PATCH']],
  // Go
  ['http.Get', ['GET']],
  ['http.Post', ['POST']],
  ['http.NewRequest', ['*']],
]);

// ─── Helper: look up HTTP methods for a call site ────────────────────────────

function resolveHttpMethods(calleeName: string, receiverName?: string): readonly string[] | null {
  const fullCallName = receiverName ? `${receiverName}.${calleeName}` : calleeName;
  return HTTP_CALL_PATTERNS.get(fullCallName) ?? HTTP_CALL_PATTERNS.get(calleeName) ?? null;
}

// ─── URL / route normalisation ────────────────────────────────────────────────

/**
 * Segment classification after normalisation. We distinguish:
 *   literal   — a concrete path segment like "api", "v2", "tasks"
 *   wildcard  — a dynamic segment from `:param`, `{param}`, or `${…}` in the URL
 */
type Segment = { kind: 'literal'; text: string } | { kind: 'wildcard' };

/** Regex that matches any of the three wildcard forms we recognise. */
const WILDCARD_RE = /^(:\w+|\{[^}]+\}|\$\{[^}]+\})$/;

/**
 * Split a URL/route path into typed segments.
 * - Leading/trailing slashes are ignored.
 * - Template expressions `${…}` are treated as wildcards.
 * - `:param` and `{param}` are treated as wildcards.
 * - Everything else is a literal segment (lowercased for comparison).
 */
function normaliseSegments(path: string): Segment[] {
  // Strip query string / fragment — we only match the path component.
  const pathOnly = path.split('?')[0].split('#')[0];
  return pathOnly
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      if (WILDCARD_RE.test(seg)) return { kind: 'wildcard' };
      return { kind: 'literal', text: seg.toLowerCase() };
    });
}

// ─── Match result ─────────────────────────────────────────────────────────────

interface MatchResult {
  confidence: number;
  resolutionMethod: ResolutionMethod;
}

/**
 * Compare a normalised URL path against a route path.
 *
 * Rules (Decision 3):
 *   1. Segment COUNT must be equal.
 *   2. Every literal segment in the URL must equal the corresponding literal
 *      segment in the route (or the route segment must be a wildcard).
 *   3. A wildcard in the URL matches any route segment (param or literal).
 *   4. Method must agree — unless the route method is '*'.
 *
 * Confidence:
 *   - All URL segments are literals AND all match → 0.95 (url_literal)
 *   - At least one wildcard segment participates → 0.8 (url_template)
 *
 * Returns null when there is no match.
 */
function matchUrlToRoute(
  urlSegments: Segment[],
  routeSegments: Segment[],
  urlMethod: string,
  routeMethod: string,
): MatchResult | null {
  // Method gate — wildcard route method always passes.
  const routeMethodUpper = routeMethod.toUpperCase();
  if (routeMethodUpper !== '*' && routeMethodUpper !== urlMethod.toUpperCase()) return null;

  // Segment count gate.
  if (urlSegments.length !== routeSegments.length) return null;

  let hasWildcard = false;

  for (let i = 0; i < urlSegments.length; i++) {
    const urlSeg = urlSegments[i];
    const routeSeg = routeSegments[i];

    if (urlSeg.kind === 'wildcard' || routeSeg.kind === 'wildcard') {
      // Either side is dynamic — counts as a wildcard match.
      hasWildcard = true;
      continue;
    }

    // Both are literals — must be equal (already lowercased).
    if (urlSeg.text !== routeSeg.text) return null;
  }

  return hasWildcard
    ? { confidence: 0.8, resolutionMethod: 'url_template' }
    : { confidence: 0.95, resolutionMethod: 'url_literal' };
}

// ─── Legacy name-heuristic (fallback for non-literal URLs) ───────────────────

/**
 * Score a route match using the legacy caller-name / route-path heuristic.
 * Used only when no statically-extractable URL is available.
 * Caps at 0.5 to stay below any url_literal / url_template match.
 * Always returns a positive value so the edge is never dropped (Decision 3).
 *
 * Method gate still applies — a POST caller cannot match a GET-only route.
 */
function scoreHeuristic(
  callerName: string,
  routeMethod: string,
  routePath: string,
  methods: readonly string[],
): number {
  const routeMethodUpper = routeMethod.toUpperCase();
  const hasWildcardMethod = methods.includes('*');
  if (!hasWildcardMethod && !methods.some((m) => m.toUpperCase() === routeMethodUpper)) return 0;

  let score = 0.3;
  const callerLower = callerName.toLowerCase();
  for (const part of routePath.split('/').filter(Boolean)) {
    if (!part.startsWith(':') && !WILDCARD_RE.test(part) && callerLower.includes(part.toLowerCase())) {
      score += 0.1; // Smaller increment than original so cap of 0.5 holds with >2 matches.
    }
  }
  return Math.min(score, 0.5);
}

// ─── Helper: process one file's calls ────────────────────────────────────────

function processFileHttpCalls(
  file: IndexedFile,
  fileQn: string,
  projectName: string,
  routes: GraphNode[],
): Omit<GraphEdge, 'id'>[] {
  if (!file.parsed) return [];
  const edges: Omit<GraphEdge, 'id'>[] = [];
  const enclosingDefs = file.parsed.definitions.filter(
    (d) => d.kind === 'Function' || d.kind === 'Method',
  );

  for (const call of file.parsed.calls) {
    const methods = resolveHttpMethods(call.calleeName, call.receiverName ?? undefined);
    if (!methods) continue;

    const enclosingDef = enclosingDefs.find(
      (d) => call.startLine >= d.startLine && call.startLine <= d.endLine,
    );
    if (!enclosingDef) continue;
    const callerQn = `${fileQn}.${enclosingDef.name}`;

    // Determine the real HTTP method for this call site (Decision 4).
    // Priority: options-object `method` field (fetch) > callee-verb (axios.post etc.) > default GET.
    let resolvedMethod: string;
    if (call.optionsMethod) {
      resolvedMethod = call.optionsMethod.toUpperCase();
    } else if (methods.includes('*')) {
      // Wildcard method — we can't determine statically; treat as any method for heuristic,
      // but for URL matching we'll let the route method gate decide.
      resolvedMethod = '*';
    } else {
      // methods[0] is the concrete verb from the call pattern map.
      resolvedMethod = (methods[0] ?? 'GET').toUpperCase();
    }

    // ── Attempt URL-based matching (Decisions 3 & 5) ──────────────────────
    if (call.firstArgValue !== undefined) {
      // We have a static URL — normalise and compare.
      const urlSegments = normaliseSegments(call.firstArgValue);
      let bestMatch: { route: GraphNode; result: MatchResult } | null = null;

      for (const route of routes) {
        const routeProps = route.props as Record<string, string>;
        const routeSegments = normaliseSegments(routeProps.path ?? '');
        const matchMethod = resolvedMethod === '*' ? (routeProps.method ?? 'GET') : resolvedMethod;
        const result = matchUrlToRoute(urlSegments, routeSegments, matchMethod, routeProps.method ?? 'GET');
        if (!result) continue;
        if (!bestMatch || result.confidence > bestMatch.result.confidence) {
          bestMatch = { route, result };
        }
      }

      if (bestMatch) {
        const routeProps = bestMatch.route.props as Record<string, string>;
        edges.push({
          project: projectName,
          source_id: callerQn,
          target_id: bestMatch.route.id,
          type: 'HTTP_CALLS',
          props: {
            confidence: bestMatch.result.confidence,
            url_path: call.firstArgValue,
            http_method: resolvedMethod === '*' ? (routeProps.method ?? 'GET') : resolvedMethod,
            resolution_method: bestMatch.result.resolutionMethod satisfies ResolutionMethod,
          },
        });
      }
      // If no route matched the static URL → orphan. No edge emitted. Intended.
      continue;
    }

    // ── Heuristic fallback for non-literal URLs (Decision 3 & 5) ─────────
    let bestScore = 0;
    let bestRoute: GraphNode | null = null;

    for (const route of routes) {
      const routeProps = route.props as Record<string, string>;
      const score = scoreHeuristic(
        enclosingDef.name,
        routeProps.method ?? 'GET',
        routeProps.path ?? '',
        methods,
      );
      if (score > bestScore) {
        bestScore = score;
        bestRoute = route;
      }
    }

    // Always emit exactly one edge for heuristic fallback — even if score is 0.3 (the floor).
    // Per Decision 3: never dropped.
    if (bestRoute !== null && bestScore > 0) {
      const routeProps = bestRoute.props as Record<string, string>;
      edges.push({
        project: projectName,
        source_id: callerQn,
        target_id: bestRoute.id,
        type: 'HTTP_CALLS',
        props: {
          confidence: bestScore,
          url_path: routeProps.path,
          http_method: resolvedMethod === '*' ? (routeProps.method ?? 'GET') : resolvedMethod,
          resolution_method: 'heuristic_name' satisfies ResolutionMethod,
        },
      });
    }
  }
  return edges;
}

// ─── Pass implementation ─────────────────────────────────────────────────────

export function httpLinkPass(
  db: GraphDatabase,
  projectName: string,
  indexedFiles: IndexedFile[],
): void {
  const routes = db.getNodesByLabel(projectName, 'Route');
  if (routes.length === 0) return;

  const allEdges: Omit<GraphEdge, 'id'>[] = [];
  for (const file of indexedFiles) {
    const fileQn = `${projectName}.${file.relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
    allEdges.push(...processFileHttpCalls(file, fileQn, projectName, routes));
  }

  const seen = new Set<string>();
  const unique = allEdges.filter((e) => {
    const key = `${e.source_id}|${e.target_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length > 0) db.insertEdges(unique);
}

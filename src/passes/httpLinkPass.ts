/**
 * httpLinkPass.ts — HTTP call-site detection pass.
 *
 * Scans extracted call sites for known HTTP client patterns (fetch, axios,
 * requests, http, httpx, https) and matches them against Route nodes already
 * present in the graph. Creates HTTP_CALLS edges with confidence scores
 * (0.0 -- 1.0) based on method match and caller-name / route-path similarity.
 */

import type { GraphDatabase } from '../graphDatabase';
import type { GraphEdge, GraphNode } from '../graphDatabaseTypes';
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

// ─── Helper: score a route match ─────────────────────────────────────────────

function scoreRouteMatch(
  callerName: string,
  routeMethod: string,
  routePath: string,
  methods: readonly string[],
): number {
  if (!methods.includes('*') && !methods.includes(routeMethod)) return 0;

  let confidence = 0.3;
  const callerLower = callerName.toLowerCase();
  for (const part of routePath.split('/').filter(Boolean)) {
    if (!part.startsWith(':') && callerLower.includes(part.toLowerCase())) confidence += 0.2;
  }
  return Math.min(confidence, 1.0);
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

    for (const route of routes) {
      const routeProps = route.props as Record<string, string>;
      const confidence = scoreRouteMatch(
        enclosingDef.name,
        routeProps.method,
        routeProps.path,
        methods,
      );
      if (confidence >= 0.3) {
        edges.push({
          project: projectName,
          source_id: callerQn,
          target_id: route.id,
          type: 'HTTP_CALLS',
          props: { confidence, url_path: routeProps.path, http_method: routeProps.method },
        });
      }
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

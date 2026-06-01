/**
 * httpLinkPass.test.ts — Regression suite for HTTP URL + method matching.
 *
 * Wave 1 Phase 1 required regression cases:
 *   (a) fetch('/api/v2/tasks') vs route /api/tasks → NO match (path mismatch → orphan)
 *   (b) POST call vs GET-only route → NO match (verb mismatch)
 *   (c) `/api/users/${id}` vs /api/users/:id → MATCH at url_template confidence ~0.8
 *   (d) computed URL (base + path) → heuristic fallback, confidence ≤ 0.5, resolution_method = 'heuristic_name', NOT dropped
 *   (e) call that previously fanned out to multiple routes → exactly ONE best-match edge emitted
 *
 * Test shape: pure logic, mocked DB. The DB seams are getNodesByLabel (returns
 * Route nodes) and insertEdges (receives edges for assertion).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphNode } from '../graphDatabaseTypes';
import type { IndexedFile } from './passTypes';
import { httpLinkPass } from './httpLinkPass';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRouteNode(id: string, method: string, path: string): GraphNode {
  return {
    id,
    project: 'proj',
    label: 'Route',
    name: path,
    qualified_name: id,
    file_path: 'src/routes.ts',
    start_line: 1,
    end_line: 5,
    props: { method, path, name: path },
  };
}

function makeDb(routes: GraphNode[] = []) {
  return {
    getNodesByLabel: vi.fn().mockReturnValue(routes),
    insertEdges: vi.fn(),
  };
}

/**
 * Build a minimal IndexedFile that contains a single Function definition
 * wrapping the given call.
 */
function makeFileWithCall(opts: {
  relativePath?: string;
  calleeName: string;
  receiverName?: string | null;
  firstArgValue?: string;
  optionsMethod?: string;
}): IndexedFile {
  return {
    relativePath: opts.relativePath ?? 'src/client.ts',
    parsed: {
      filePath: opts.relativePath ?? 'src/client.ts',
      language: 'typescript',
      lineCount: 20,
      definitions: [
        {
          kind: 'Function',
          name: 'fetchTasks',
          startLine: 1,
          endLine: 20,
          signature: null,
          returnType: null,
          isExported: true,
          isDefault: false,
          isAsync: true,
          isStatic: false,
          isAbstract: false,
          decorators: [],
          receiver: null,
          constants: [],
        } as never,
      ],
      imports: [],
      calls: [
        {
          calleeName: opts.calleeName,
          receiverName: opts.receiverName ?? null,
          startLine: 5,
          isAsync: true,
          arguments: opts.firstArgValue !== undefined ? 1 : 0,
          isNewExpression: false,
          firstArgValue: opts.firstArgValue,
          optionsMethod: opts.optionsMethod,
        },
      ],
      routes: [],
      exportedNames: [],
    },
  };
}

// ─── (a) Path mismatch → orphan ───────────────────────────────────────────────

describe('(a) fetch("/api/v2/tasks") vs route /api/tasks → no match (orphan)', () => {
  it('emits no edge when the URL has a different path depth than the route', () => {
    const routes = [makeRouteNode('proj.routes.tasks', 'GET', '/api/tasks')];
    const db = makeDb(routes);

    const file = makeFileWithCall({ calleeName: 'fetch', firstArgValue: '/api/v2/tasks' });
    httpLinkPass(db as never, 'proj', [file]);

    // The URL /api/v2/tasks has 3 segments; /api/tasks has 2 — count mismatch → no edge.
    expect(db.insertEdges).not.toHaveBeenCalled();
  });

  it('emits no edge when literal path segments differ even with equal count', () => {
    const routes = [makeRouteNode('proj.routes.users', 'GET', '/api/users')];
    const db = makeDb(routes);

    const file = makeFileWithCall({ calleeName: 'fetch', firstArgValue: '/api/tasks' });
    httpLinkPass(db as never, 'proj', [file]);

    expect(db.insertEdges).not.toHaveBeenCalled();
  });
});

// ─── (b) Verb mismatch → no match ────────────────────────────────────────────

describe('(b) POST call vs GET-only route → no match', () => {
  it('emits no edge when axios.post targets a GET-only route', () => {
    const routes = [makeRouteNode('proj.routes.tasks', 'GET', '/api/tasks')];
    const db = makeDb(routes);

    // axios.post → resolves to ['POST'] from the call pattern map.
    const file = makeFileWithCall({
      calleeName: 'post',
      receiverName: 'axios',
      firstArgValue: '/api/tasks',
    });
    httpLinkPass(db as never, 'proj', [file]);

    expect(db.insertEdges).not.toHaveBeenCalled();
  });

  it('emits no edge when fetch with { method: "DELETE" } targets a GET-only route', () => {
    const routes = [makeRouteNode('proj.routes.tasks', 'GET', '/api/tasks')];
    const db = makeDb(routes);

    const file = makeFileWithCall({
      calleeName: 'fetch',
      firstArgValue: '/api/tasks',
      optionsMethod: 'DELETE',
    });
    httpLinkPass(db as never, 'proj', [file]);

    expect(db.insertEdges).not.toHaveBeenCalled();
  });
});

// ─── (c) Template literal vs :param route → url_template match ───────────────

describe('(c) `/api/users/${id}` vs /api/users/:id → MATCH at url_template', () => {
  it('emits one edge with confidence 0.8 and resolution_method url_template', () => {
    const routes = [makeRouteNode('proj.routes.userById', 'GET', '/api/users/:id')];
    const db = makeDb(routes);

    // tree-sitter preserves the raw template text including ${}; firstArgValue
    // will contain the raw segment text after stripping surrounding backticks.
    const file = makeFileWithCall({
      calleeName: 'fetch',
      // Simulates the raw text captured from a template literal node after quote-stripping.
      firstArgValue: '/api/users/${id}',
    });
    httpLinkPass(db as never, 'proj', [file]);

    expect(db.insertEdges).toHaveBeenCalledOnce();
    const [edges] = db.insertEdges.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(edges).toHaveLength(1);
    const edge = edges[0];
    expect(edge.type).toBe('HTTP_CALLS');
    expect((edge.props as Record<string, unknown>).confidence).toBe(0.8);
    expect((edge.props as Record<string, unknown>).resolution_method).toBe('url_template');
  });

  it('also matches when the route uses {param} syntax and URL uses a literal', () => {
    const routes = [makeRouteNode('proj.routes.userById', 'GET', '/api/users/{id}')];
    const db = makeDb(routes);

    const file = makeFileWithCall({
      calleeName: 'fetch',
      firstArgValue: '/api/users/42',
    });
    httpLinkPass(db as never, 'proj', [file]);

    expect(db.insertEdges).toHaveBeenCalledOnce();
    const [edges] = db.insertEdges.mock.calls[0] as [Array<Record<string, unknown>>];
    expect((edges[0].props as Record<string, unknown>).resolution_method).toBe('url_template');
    expect((edges[0].props as Record<string, unknown>).confidence).toBe(0.8);
  });

  it('produces url_literal at confidence 0.95 when both path and method are exact literals', () => {
    const routes = [makeRouteNode('proj.routes.tasks', 'GET', '/api/tasks')];
    const db = makeDb(routes);

    const file = makeFileWithCall({
      calleeName: 'fetch',
      firstArgValue: '/api/tasks',
    });
    httpLinkPass(db as never, 'proj', [file]);

    expect(db.insertEdges).toHaveBeenCalledOnce();
    const [edges] = db.insertEdges.mock.calls[0] as [Array<Record<string, unknown>>];
    expect((edges[0].props as Record<string, unknown>).confidence).toBe(0.95);
    expect((edges[0].props as Record<string, unknown>).resolution_method).toBe('url_literal');
  });
});

// ─── (d) Non-literal URL → heuristic fallback, low confidence, not dropped ───

describe('(d) computed URL → heuristic fallback with confidence ≤ 0.5, not dropped', () => {
  it('emits one edge tagged heuristic_name with confidence ≤ 0.5 when firstArgValue is absent', () => {
    // A route that the legacy heuristic can score positively — caller name
    // contains "tasks" which appears in route path /api/tasks.
    const routes = [makeRouteNode('proj.routes.tasks', 'GET', '/api/tasks')];
    const db = makeDb(routes);

    // No firstArgValue → computed URL → heuristic path.
    const file: IndexedFile = {
      relativePath: 'src/client.ts',
      parsed: {
        filePath: 'src/client.ts',
        language: 'typescript',
        lineCount: 20,
        definitions: [
          {
            kind: 'Function',
            name: 'fetchTasks', // name contains "tasks" — heuristic will score it
            startLine: 1,
            endLine: 20,
            signature: null,
            returnType: null,
            isExported: true,
            isDefault: false,
            isAsync: true,
            isStatic: false,
            isAbstract: false,
            decorators: [],
            receiver: null,
            constants: [],
          } as never,
        ],
        imports: [],
        calls: [
          {
            calleeName: 'fetch',
            receiverName: null,
            startLine: 5,
            isAsync: true,
            arguments: 1,
            isNewExpression: false,
            // No firstArgValue — simulates `fetch(BASE_URL + '/tasks')`
            firstArgValue: undefined,
            optionsMethod: undefined,
          },
        ],
        routes: [],
        exportedNames: [],
      },
    };

    httpLinkPass(db as never, 'proj', [file]);

    expect(db.insertEdges).toHaveBeenCalledOnce();
    const [edges] = db.insertEdges.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(edges).toHaveLength(1);
    const props = edges[0].props as Record<string, unknown>;
    expect(props.resolution_method).toBe('heuristic_name');
    expect(typeof props.confidence).toBe('number');
    expect(props.confidence as number).toBeLessThanOrEqual(0.5);
    expect(props.confidence as number).toBeGreaterThan(0);
  });
});

// ─── (e) Single best-match edge, no fan-out ───────────────────────────────────

describe('(e) single best-match edge emitted, no fan-out', () => {
  it('emits exactly one edge to the highest-confidence route when multiple routes share the same path prefix', () => {
    // Two routes that would both have matched under the old fan-out logic
    // because the old code emitted an edge for every route ≥ 0.3.
    // Under the new logic, only the single best match is emitted.
    const routes = [
      makeRouteNode('proj.routes.tasks.list', 'GET', '/api/tasks'),
      makeRouteNode('proj.routes.tasks.create', 'POST', '/api/tasks'),
    ];
    const db = makeDb(routes);

    // fetch('/api/tasks') — defaults to GET. Only the GET route should match.
    const file = makeFileWithCall({ calleeName: 'fetch', firstArgValue: '/api/tasks' });
    httpLinkPass(db as never, 'proj', [file]);

    expect(db.insertEdges).toHaveBeenCalledOnce();
    const [edges] = db.insertEdges.mock.calls[0] as [Array<Record<string, unknown>>];
    // Exactly ONE edge.
    expect(edges).toHaveLength(1);
    // It must be the GET route.
    expect(edges[0].target_id).toBe('proj.routes.tasks.list');
  });

  it('picks the url_literal match over a url_template match when both routes are candidates', () => {
    const routes = [
      makeRouteNode('proj.routes.userById', 'GET', '/api/users/:id'), // wildcard → url_template (0.8)
      makeRouteNode('proj.routes.usersLiteral', 'GET', '/api/users/42'), // exact → url_literal (0.95)
    ];
    const db = makeDb(routes);

    // Exact literal URL — should match the literal route at 0.95, not the param route at 0.8.
    const file = makeFileWithCall({ calleeName: 'fetch', firstArgValue: '/api/users/42' });
    httpLinkPass(db as never, 'proj', [file]);

    expect(db.insertEdges).toHaveBeenCalledOnce();
    const [edges] = db.insertEdges.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(edges).toHaveLength(1);
    expect(edges[0].target_id).toBe('proj.routes.usersLiteral');
    expect((edges[0].props as Record<string, unknown>).confidence).toBe(0.95);
  });
});

// ─── Method extraction from fetch options ─────────────────────────────────────

describe('fetch options object method extraction (Decision 4)', () => {
  it('resolves fetch({ method: "POST" }) as POST and matches a POST route', () => {
    const routes = [makeRouteNode('proj.routes.tasks', 'POST', '/api/tasks')];
    const db = makeDb(routes);

    const file = makeFileWithCall({
      calleeName: 'fetch',
      firstArgValue: '/api/tasks',
      optionsMethod: 'POST', // extracted from { method: 'POST' }
    });
    httpLinkPass(db as never, 'proj', [file]);

    expect(db.insertEdges).toHaveBeenCalledOnce();
    const [edges] = db.insertEdges.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(edges).toHaveLength(1);
    expect((edges[0].props as Record<string, unknown>).http_method).toBe('POST');
  });

  it('fetch defaults to GET and does not match a POST-only route', () => {
    const routes = [makeRouteNode('proj.routes.tasks', 'POST', '/api/tasks')];
    const db = makeDb(routes);

    // No optionsMethod → defaults to GET.
    const file = makeFileWithCall({ calleeName: 'fetch', firstArgValue: '/api/tasks' });
    httpLinkPass(db as never, 'proj', [file]);

    expect(db.insertEdges).not.toHaveBeenCalled();
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('emits no edges when there are no Route nodes in the DB', () => {
    const db = makeDb([]);
    const file = makeFileWithCall({ calleeName: 'fetch', firstArgValue: '/api/tasks' });
    httpLinkPass(db as never, 'proj', [file]);
    expect(db.insertEdges).not.toHaveBeenCalled();
  });

  it('emits no edges when the parsed result is null (unparseable file)', () => {
    const routes = [makeRouteNode('proj.routes.tasks', 'GET', '/api/tasks')];
    const db = makeDb(routes);
    const file: IndexedFile = { relativePath: 'src/client.ts', parsed: null };
    httpLinkPass(db as never, 'proj', [file]);
    expect(db.insertEdges).not.toHaveBeenCalled();
  });

  it('deduplicates edges from multiple call sites that resolve to the same source→target pair', () => {
    const routes = [makeRouteNode('proj.routes.tasks', 'GET', '/api/tasks')];
    const db = makeDb(routes);

    // Two separate fetch('/api/tasks') calls inside the same function → same source QN.
    const file: IndexedFile = {
      relativePath: 'src/client.ts',
      parsed: {
        filePath: 'src/client.ts',
        language: 'typescript',
        lineCount: 30,
        definitions: [
          {
            kind: 'Function',
            name: 'fetchTasks',
            startLine: 1,
            endLine: 30,
            signature: null,
            returnType: null,
            isExported: true,
            isDefault: false,
            isAsync: true,
            isStatic: false,
            isAbstract: false,
            decorators: [],
            receiver: null,
            constants: [],
          } as never,
        ],
        imports: [],
        calls: [
          {
            calleeName: 'fetch',
            receiverName: null,
            startLine: 5,
            isAsync: true,
            arguments: 1,
            isNewExpression: false,
            firstArgValue: '/api/tasks',
            optionsMethod: undefined,
          },
          {
            calleeName: 'fetch',
            receiverName: null,
            startLine: 15,
            isAsync: true,
            arguments: 1,
            isNewExpression: false,
            firstArgValue: '/api/tasks',
            optionsMethod: undefined,
          },
        ],
        routes: [],
        exportedNames: [],
      },
    };

    httpLinkPass(db as never, 'proj', [file]);

    expect(db.insertEdges).toHaveBeenCalledOnce();
    const [edges] = db.insertEdges.mock.calls[0] as [Array<Record<string, unknown>>];
    // Deduplication: two calls with same source QN and target → only 1 edge.
    expect(edges).toHaveLength(1);
  });
});

// ─── resolution_method is always set on emitted edges ────────────────────────

describe('every emitted HTTP_CALLS edge carries props.resolution_method', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('url_literal edge carries resolution_method = "url_literal"', () => {
    const routes = [makeRouteNode('proj.routes.tasks', 'GET', '/api/tasks')];
    const db = makeDb(routes);
    httpLinkPass(db as never, 'proj', [
      makeFileWithCall({ calleeName: 'fetch', firstArgValue: '/api/tasks' }),
    ]);
    const [edges] = db.insertEdges.mock.calls[0] as [Array<Record<string, unknown>>];
    expect((edges[0].props as Record<string, unknown>).resolution_method).toBe('url_literal');
  });

  it('heuristic_name edge carries resolution_method = "heuristic_name"', () => {
    const routes = [makeRouteNode('proj.routes.tasks', 'GET', '/api/tasks')];
    const db = makeDb(routes);

    const file: IndexedFile = {
      relativePath: 'src/client.ts',
      parsed: {
        filePath: 'src/client.ts',
        language: 'typescript',
        lineCount: 20,
        definitions: [
          {
            kind: 'Function',
            name: 'fetchTasks',
            startLine: 1,
            endLine: 20,
            signature: null,
            returnType: null,
            isExported: true,
            isDefault: false,
            isAsync: true,
            isStatic: false,
            isAbstract: false,
            decorators: [],
            receiver: null,
            constants: [],
          } as never,
        ],
        imports: [],
        calls: [
          {
            calleeName: 'fetch',
            receiverName: null,
            startLine: 5,
            isAsync: true,
            arguments: 1,
            isNewExpression: false,
            firstArgValue: undefined,
            optionsMethod: undefined,
          },
        ],
        routes: [],
        exportedNames: [],
      },
    };

    httpLinkPass(db as never, 'proj', [file]);
    const [edges] = db.insertEdges.mock.calls[0] as [Array<Record<string, unknown>>];
    expect((edges[0].props as Record<string, unknown>).resolution_method).toBe('heuristic_name');
  });
});

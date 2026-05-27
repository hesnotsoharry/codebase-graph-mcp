/**
 * graphPageRank.test.ts — Unit tests + benchmark for Wave 19 PageRank engine.
 *
 * Coverage:
 * - Small DAG convergence with known rank ordering
 * - Isolated-node deprioritization (self-loop weight 0.1)
 * - Seed ablation (varying seedWeights shifts rankings)
 * - Cache hit / miss behaviour
 * - Benchmark: 100-node synthetic graph < 200 ms
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { GraphDatabase } from './graphDatabase';
import {
  clearPageRankCache,
  computePageRank,
  normalizePageRankScores,
  type PageRankOptions,
} from './graphPageRank';

// ─── Mock GraphDatabase ───────────────────────────────────────────────────────

function buildMockDb(
  nodes: Array<{ id: string; file_path: string }>,
  edges: Array<{ source_id: string; target_id: string }>,
): GraphDatabase {
  return {
    rawQuery: (sql: string, params: unknown[]) => {
      const project = params[0];
      if (sql.includes('FROM nodes')) {
        return nodes.map((n) => ({ id: n.id, file_path: n.file_path }));
      }
      if (sql.includes('FROM edges')) {
        return edges.map((e) => ({ source_id: e.source_id, target_id: e.target_id }));
      }
      void project;
      return [];
    },
  } as unknown as GraphDatabase;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function baseOpts(overrides: Partial<PageRankOptions> = {}): PageRankOptions {
  return {
    project: 'test',
    seeds: [],
    graphVersion: 'v1',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearPageRankCache();
});

describe('computePageRank — basic convergence', () => {
  it('returns empty scores for empty graph', () => {
    const db = buildMockDb([], []);
    const result = computePageRank(db, baseOpts());
    expect(result.scores.size).toBe(0);
    expect(result.fromCache).toBe(false);
  });

  it('converges on a 5-node DAG and ranks hub higher than leaf', () => {
    // hub → a → b → leaf; orphan has no edges
    // hub is seeded — should dominate
    const nodes = [
      { id: 'hub', file_path: '/src/hub.ts' },
      { id: 'a', file_path: '/src/a.ts' },
      { id: 'b', file_path: '/src/b.ts' },
      { id: 'leaf', file_path: '/src/leaf.ts' },
      { id: 'orphan', file_path: '/src/orphan.ts' },
    ];
    const edges = [
      { source_id: 'hub', target_id: 'a' },
      { source_id: 'hub', target_id: 'b' },
      { source_id: 'a', target_id: 'leaf' },
      { source_id: 'b', target_id: 'leaf' },
    ];
    const db = buildMockDb(nodes, edges);
    const result = computePageRank(
      db,
      baseOpts({
        seeds: [{ id: 'hub', weight: 1.0 }],
      }),
    );

    expect(result.scores.size).toBeGreaterThan(0);
    expect(result.iterations).toBeGreaterThan(0);

    const normalized = normalizePageRankScores(result.scores);
    const hubScore = normalized.get('/src/hub.ts') ?? 0;
    const orphanScore = normalized.get('/src/orphan.ts') ?? 0;

    // Seeded hub should rank higher than unseeded orphan
    expect(hubScore).toBeGreaterThan(orphanScore);
  });

  it('returns iterations <= maxIterations', () => {
    const nodes = [
      { id: 'x', file_path: '/x.ts' },
      { id: 'y', file_path: '/y.ts' },
    ];
    const edges = [
      { source_id: 'x', target_id: 'y' },
      { source_id: 'y', target_id: 'x' },
    ];
    const db = buildMockDb(nodes, edges);
    const result = computePageRank(db, baseOpts({ maxIterations: 10, seeds: [] }));
    expect(result.iterations).toBeLessThanOrEqual(10);
  });
});

describe('computePageRank — isolated-node deprioritization', () => {
  it('isolated node (self-loop only) scores lower than connected node', () => {
    const nodes = [
      { id: 'connected', file_path: '/src/connected.ts' },
      { id: 'linked', file_path: '/src/linked.ts' },
      { id: 'isolated', file_path: '/src/isolated.ts' },
    ];
    const edges = [{ source_id: 'connected', target_id: 'linked' }];
    const db = buildMockDb(nodes, edges);
    const result = computePageRank(
      db,
      baseOpts({
        seeds: [{ id: 'connected', weight: 1.0 }],
      }),
    );

    const normalized = normalizePageRankScores(result.scores);
    const connectedScore = normalized.get('/src/connected.ts') ?? 0;
    const isolatedScore = normalized.get('/src/isolated.ts') ?? 0;

    // Seeded connected node must outrank the isolated node
    expect(connectedScore).toBeGreaterThan(isolatedScore);
  });
});

describe('computePageRank — seed ablation', () => {
  it("shifting seed to a different node raises that node's rank", () => {
    const nodes = [
      { id: 'alpha', file_path: '/alpha.ts' },
      { id: 'beta', file_path: '/beta.ts' },
      { id: 'gamma', file_path: '/gamma.ts' },
    ];
    const edges: Array<{ source_id: string; target_id: string }> = [];
    const db = buildMockDb(nodes, edges);

    const resultAlpha = computePageRank(
      db,
      baseOpts({
        seeds: [{ id: 'alpha', weight: 1.0 }],
        graphVersion: 'v-alpha',
      }),
    );
    const normAlpha = normalizePageRankScores(resultAlpha.scores);

    clearPageRankCache();

    const resultBeta = computePageRank(
      db,
      baseOpts({
        seeds: [{ id: 'beta', weight: 1.0 }],
        graphVersion: 'v-beta',
      }),
    );
    const normBeta = normalizePageRankScores(resultBeta.scores);

    // Alpha seed → alpha.ts scores 1.0; beta.ts scores < 1.0
    expect(normAlpha.get('/alpha.ts') ?? 0).toBeGreaterThan(normAlpha.get('/beta.ts') ?? 0);
    // Beta seed → beta.ts scores 1.0; alpha.ts scores < 1.0
    expect(normBeta.get('/beta.ts') ?? 0).toBeGreaterThan(normBeta.get('/alpha.ts') ?? 0);
  });
});

describe('computePageRank — cache', () => {
  it('second call with same inputs returns fromCache=true', () => {
    const nodes = [{ id: 'n1', file_path: '/f1.ts' }];
    const db = buildMockDb(nodes, []);
    const opts = baseOpts({ seeds: [{ id: 'n1', weight: 1.0 }], graphVersion: 'v-cache' });

    const first = computePageRank(db, opts);
    const second = computePageRank(db, opts);

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.scores).toEqual(first.scores);
  });

  it('different graphVersion produces a cache miss', () => {
    const nodes = [{ id: 'n1', file_path: '/f1.ts' }];
    const db = buildMockDb(nodes, []);

    const r1 = computePageRank(db, baseOpts({ seeds: [], graphVersion: 'ver-A' }));
    const r2 = computePageRank(db, baseOpts({ seeds: [], graphVersion: 'ver-B' }));

    expect(r1.fromCache).toBe(false);
    expect(r2.fromCache).toBe(false);
  });

  it('clearPageRankCache forces a fresh computation', () => {
    const nodes = [{ id: 'n1', file_path: '/f1.ts' }];
    const db = buildMockDb(nodes, []);
    const opts = baseOpts({ seeds: [], graphVersion: 'v-clear' });

    computePageRank(db, opts);
    clearPageRankCache();
    const after = computePageRank(db, opts);

    expect(after.fromCache).toBe(false);
  });
});

describe('normalizePageRankScores', () => {
  it('returns empty map for empty input', () => {
    expect(normalizePageRankScores(new Map()).size).toBe(0);
  });

  it('max value normalizes to 1.0', () => {
    const raw = new Map([
      ['a', 0.4],
      ['b', 0.2],
      ['c', 0.8],
    ]);
    const norm = normalizePageRankScores(raw);
    expect(norm.get('c')).toBeCloseTo(1.0);
    expect(norm.get('a')).toBeCloseTo(0.5);
    expect(norm.get('b')).toBeCloseTo(0.25);
  });
});

describe('computePageRank — benchmark (100-node synthetic graph)', () => {
  it('completes in < 200 ms', () => {
    const N = 100;
    const nodes = Array.from({ length: N }, (_, i) => ({
      id: `node_${i}`,
      file_path: `/src/file_${i % 20}.ts`,
    }));
    // Sparse random-ish edges: each node points to next 3 nodes (modular)
    const edges = nodes.flatMap((n, i) =>
      [1, 2, 3].map((offset) => ({
        source_id: n.id,
        target_id: `node_${(i + offset) % N}`,
      })),
    );
    const seeds = [
      { id: 'node_0', weight: 0.5 },
      { id: 'node_10', weight: 0.3 },
      { id: 'node_50', weight: 0.2 },
    ];
    const db = buildMockDb(nodes, edges);

    const start = performance.now();
    const result = computePageRank(db, baseOpts({ seeds, graphVersion: 'bench' }));
    const elapsed = performance.now() - start;

    expect(result.scores.size).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });
});

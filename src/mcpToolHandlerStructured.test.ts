/**
 * mcpToolHandlerStructured.test.ts — Wave 70 Phase B1+B2+B4 smoke coverage.
 *
 * Verifies that:
 *  - handleIndexStatus returns the MCP envelope ({content, structuredContent})
 *  - parseAnomalies is always present in structuredContent (B4 always-emit)
 *  - structuredContent carries node/edge counts for downstream consumers
 *  - handleGetArchitecture returns envelope + structured aspects map
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
  getLogPath: vi.fn(() => ''),
}));

vi.mock('../ipc-handlers/gitOperations', () => ({
  gitExec: vi.fn(async () => ''),
  gitTrimmed: vi.fn(async () => ''),
}));

import { CypherEngine } from './cypherEngine';
import { GraphDatabase } from './graphDatabase';
import type { GraphToolContext } from './graphTypes';
import {
  handleGetArchitecture,
  handleIndexStatus,
  readParseAnomalies,
} from './mcpToolHandlerStructured';
import { QueryEngine } from './queryEngine';

const PROJECT = 'test-structured';
let db: GraphDatabase;
let ctx: GraphToolContext;
let fixtureDir: string;

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-structured-test-'));
  db = new GraphDatabase(':memory:');
  db.upsertProject({
    name: PROJECT,
    root_path: fixtureDir,
    indexed_at: Date.now(),
    node_count: 1,
    edge_count: 0,
  });
  db.insertNodes([
    {
      id: `${PROJECT}.foo.ts.fn`,
      project: PROJECT,
      label: 'Function',
      name: 'fn',
      qualified_name: `${PROJECT}.foo.ts.fn`,
      file_path: 'foo.ts',
      start_line: 1,
      end_line: 1,
      props: {},
    },
  ]);

  const qe = new QueryEngine(db, PROJECT, fixtureDir);
  const ce = new CypherEngine(db, PROJECT);
  ctx = {
    db,
    queryEngine: qe,
    cypherEngine: ce,
    pipeline: {
      index: async () => ({
        success: true,
        projectName: PROJECT,
        filesIndexed: 0,
        filesSkipped: 0,
        nodesCreated: 0,
        edgesCreated: 0,
        durationMs: 0,
        incremental: true,
        errors: [],
      }),
    },
    projectRoot: fixtureDir,
    projectName: PROJECT,
  };
});

afterAll(() => {
  db.close();
  try {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

describe('handleIndexStatus — MCP envelope (Phase B1)', () => {
  it('returns content array with one text block', async () => {
    const result = await handleIndexStatus({}, ctx);
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain(PROJECT);
  });

  it('omits isError on success', async () => {
    const result = await handleIndexStatus({}, ctx);
    expect(result.isError).toBeUndefined();
  });

  it('sets isError + indexed:false envelope for unknown project', async () => {
    const result = await handleIndexStatus({ project: 'ghost' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('is not indexed');
    expect(result.structuredContent?.indexed).toBe(false);
  });
});

describe('handleIndexStatus — structuredContent (Phase B2)', () => {
  it('includes node/edge counts in structuredContent', async () => {
    const result = await handleIndexStatus({}, ctx);
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent?.project).toBe(PROJECT);
    expect(result.structuredContent?.indexed).toBe(true);
    expect(result.structuredContent?.totalNodes).toBe(1);
  });

  it('honors project arg over project_name alias', async () => {
    const result = await handleIndexStatus(
      { project: PROJECT, project_name: 'ghost' },
      ctx,
    );
    expect(result.structuredContent?.project).toBe(PROJECT);
    expect(result.isError).toBeUndefined();
  });
});

describe('handleIndexStatus — parseAnomalies always-emit (Phase B4)', () => {
  it('emits parseAnomalies:{count:0,files:[]} when none recorded', async () => {
    const result = await handleIndexStatus({}, ctx);
    const sc = result.structuredContent as { parseAnomalies?: unknown } | undefined;
    expect(sc?.parseAnomalies).toBeDefined();
    expect(sc?.parseAnomalies).toEqual({ count: 0, files: [] });
  });

  it('text content includes "Parse anomalies: 0 file(s)" line on zero count', async () => {
    const result = await handleIndexStatus({}, ctx);
    expect(result.content[0].text).toContain('Parse anomalies: 0 file(s)');
  });
});

describe('readParseAnomalies', () => {
  it('returns zero shape when metadata key is absent', () => {
    const r = readParseAnomalies('definitely-not-a-project', ctx);
    expect(r).toEqual({ count: 0, files: [] });
  });

  it('round-trips 8 anomaly paths without truncation (v0.2.2 full-list guarantee)', () => {
    // Write a stored anomaly payload that exceeds the old 5-sample cap.
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts'];
    db.setGraphMetadata(
      `parse_anomalies:${PROJECT}`,
      JSON.stringify({ count: 8, files: paths }),
    );
    const r = readParseAnomalies(PROJECT, ctx);
    expect(r.count).toBe(8);
    expect(r.files).toHaveLength(8);
    expect(r.files).toEqual(paths);
  });

  it('reads legacy stored shape (samples field) without data loss on first boot after upgrade', () => {
    // Older builds stored the field as `samples`. Verify the backwards-compat
    // fallback in readParseAnomalies so a reindex isn't required after upgrading.
    const legacyPaths = ['x.ts', 'y.ts', 'z.ts'];
    db.setGraphMetadata(
      `parse_anomalies:${PROJECT}`,
      JSON.stringify({ count: 3, samples: legacyPaths }),
    );
    const r = readParseAnomalies(PROJECT, ctx);
    expect(r.count).toBe(3);
    expect(r.files).toEqual(legacyPaths);
  });
});

describe('handleGetArchitecture — MCP envelope (Phase B1+B2)', () => {
  it('returns envelope with structuredContent.aspects', async () => {
    const result = await handleGetArchitecture({ aspects: ['file_tree'] }, ctx);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Architecture');
    expect(result.structuredContent?.project).toBe(PROJECT);
    expect(result.structuredContent?.aspects).toBeDefined();
  });
});

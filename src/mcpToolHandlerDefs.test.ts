/**
 * mcpToolHandlerDefs.test.ts — Phase A aliasing tests for handleGetCodeSnippet
 * and handleIndexStatus.
 *
 * Uses a real GraphDatabase(':memory:') with a minimal fixture.
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
import { handleGetCodeSnippet, handleIndexStatus } from './mcpToolHandlerDefs';
import type { GraphToolContext } from './mcpToolHandlers';
import { QueryEngine } from './queryEngine';

// ─── Fixture ──────────────────────────────────────────────────────────────────

const PROJECT = 'test-defs';
let db: GraphDatabase;
let ctx: GraphToolContext;
let fixtureDir: string;

beforeAll(() => {
  // Create a real file on disk so getCodeSnippet can read it
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-defs-test-'));
  const srcFile = path.join(fixtureDir, 'foo.ts');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
  fs.writeFileSync(srcFile, 'export function uniqueFn(): void {}\n', 'utf8');
  const dualFile = path.join(fixtureDir, 'bar.ts');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
  fs.writeFileSync(dualFile, 'export function dupFn(): void {}\nexport function dupFn2(): void {}\n', 'utf8');

  db = new GraphDatabase(':memory:');
  db.upsertProject({
    name: PROJECT,
    root_path: fixtureDir,
    indexed_at: Date.now(),
    node_count: 2,
    edge_count: 0,
  });

  db.insertNodes([
    {
      id: `${PROJECT}.foo.ts.uniqueFn`,
      project: PROJECT,
      label: 'Function',
      name: 'uniqueFn',
      qualified_name: `${PROJECT}.foo.ts.uniqueFn`,
      file_path: 'foo.ts',
      start_line: 1,
      end_line: 1,
      props: {},
    },
    {
      id: `${PROJECT}.bar.ts.dupFn`,
      project: PROJECT,
      label: 'Function',
      name: 'dupFn',
      qualified_name: `${PROJECT}.bar.ts.dupFn`,
      file_path: 'bar.ts',
      start_line: 1,
      end_line: 1,
      props: {},
    },
    {
      id: `${PROJECT}.bar.ts.dupFn2`,
      project: PROJECT,
      label: 'Function',
      name: 'dupFn',
      qualified_name: `${PROJECT}.bar.ts.dupFn2`,
      file_path: 'bar.ts',
      start_line: 2,
      end_line: 2,
      props: {},
    },
  ]);

  const qe = new QueryEngine(db, PROJECT, fixtureDir);
  const ce = new CypherEngine(db, PROJECT);
  ctx = {
    db,
    queryEngine: qe,
    cypherEngine: ce,
    pipeline: { index: async () => ({ success: true, projectName: PROJECT, filesIndexed: 0, filesSkipped: 0, nodesCreated: 0, edgesCreated: 0, durationMs: 0, incremental: true, errors: [] }) },
    projectRoot: fixtureDir,
    projectName: PROJECT,
  };
});

afterAll(() => {
  db.close();
  try {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  } catch { /* swallow */ }
});

// ─── handleGetCodeSnippet ─────────────────────────────────────────────────────
//
// Wave 70 Phase B3: deprecated `qualified_name` alias dropped. `symbol` is the
// only accepted parameter name.

describe('handleGetCodeSnippet — parameter handling (Wave 70)', () => {
  it('accepts symbol (qualified name)', async () => {
    const qn = `${PROJECT}.foo.ts.uniqueFn`;
    const result = await handleGetCodeSnippet({ symbol: qn }, ctx);
    expect(result).toContain('uniqueFn');
    expect(result).not.toMatch(/^Error:/);
    expect(result).not.toContain('Symbol not found');
  });

  it('bare symbol name auto-resolves when unique', async () => {
    const result = await handleGetCodeSnippet({ symbol: 'uniqueFn' }, ctx);
    expect(result).toContain('uniqueFn');
    expect(result).not.toMatch(/^Error:/);
    expect(result).not.toContain('Symbol not found');
  });

  it('returns ambiguous error when bare name matches multiple nodes', async () => {
    const result = await handleGetCodeSnippet({ symbol: 'dupFn' }, ctx);
    expect(result).toMatch(/^Error: ambiguous symbol/);
    expect(result).toContain('dupFn');
  });

  it('returns Symbol not found for truly unknown bare name', async () => {
    const result = await handleGetCodeSnippet({ symbol: 'noSuchFn' }, ctx);
    expect(result).toContain('Symbol not found');
  });

  it('returns error string when no symbol given', async () => {
    const result = await handleGetCodeSnippet({}, ctx);
    expect(result).toMatch(/^Error: missing required parameter/);
  });

  it('Wave 70 Phase B3: deprecated qualified_name alias is no longer accepted', async () => {
    const qn = `${PROJECT}.foo.ts.uniqueFn`;
    const result = await handleGetCodeSnippet({ qualified_name: qn }, ctx);
    expect(result).toMatch(/^Error: missing required parameter/);
  });
});

// ─── handleIndexStatus ────────────────────────────────────────────────────────
//
// Wave 70 Phase B1: now returns the MCP envelope. The legacy parameter alias
// `project_name` still resolves (back-compat with non-MCP callers); the only
// formerly-accepted alias dropped here is in the MCP tool schema, not the
// handler. Detailed envelope coverage lives in mcpToolHandlerStructured.test.ts.

describe('handleIndexStatus — parameter aliasing (Wave 70 envelope)', () => {
  it('returns live counts when no project arg given (defaults to ctx.projectName)', async () => {
    const result = await handleIndexStatus({}, ctx);
    expect(result.content[0].text).toContain(PROJECT);
    expect(result.isError).toBeUndefined();
  });

  it('accepts project arg', async () => {
    const result = await handleIndexStatus({ project: PROJECT }, ctx);
    expect(result.content[0].text).toContain(PROJECT);
    expect(result.isError).toBeUndefined();
  });

  it('accepts project_name arg (back-compat alias on the handler)', async () => {
    const result = await handleIndexStatus({ project_name: PROJECT }, ctx);
    expect(result.content[0].text).toContain(PROJECT);
    expect(result.isError).toBeUndefined();
  });

  it('project wins over project_name when both are passed', async () => {
    const result = await handleIndexStatus(
      { project: PROJECT, project_name: 'nonexistent' },
      ctx,
    );
    expect(result.content[0].text).toContain(PROJECT);
    expect(result.isError).toBeUndefined();
  });

  it('flags isError + indexed:false envelope for unknown project name', async () => {
    const result = await handleIndexStatus({ project: 'ghost-project' }, ctx);
    expect(result.content[0].text).toContain('is not indexed');
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.indexed).toBe(false);
  });
});

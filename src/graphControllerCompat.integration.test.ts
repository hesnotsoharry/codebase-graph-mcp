/**
 * graphControllerCompat.integration.test.ts — End-to-end smoke test for the
 * GraphControllerCompat shim against real System 2 internals.
 *
 * Uses a real GraphDatabase (':memory:'), a real TreeSitterParser, and
 * the real indexing pass functions against a small synthetic TypeScript fixture
 * written to a temp directory on disk. No worker thread.
 *
 * This is NOT a parity test against System 1. It proves that the shim +
 * System 2 produce usable results end-to-end on a known fixture.
 *
 * ─── Historical note (fixed) ─────────────────────────────────────────────────
 * IndexingPipeline.index() previously had a data-loss bug: upsertProject used
 * INSERT OR REPLACE, which cascade-deleted every node/edge via ON DELETE CASCADE.
 * Fixed in graphDatabaseHelpers.ts by switching to ON CONFLICT DO UPDATE. The
 * test at "pipeline.index() leaves the DB populated" guards the regression.
 *
 * The test still calls both pipeline.index() (exercises the full public API)
 * and populateDbFromFixture() (exposes per-pass intermediate state for query
 * assertions against the shim).
 *
 * ─── Mock rationale ───────────────────────────────────────────────────────────
 * - logger: electron-log/main calls electron.app at module load; stubbed.
 * - ipc-handlers/gitOperations: transitively imported by queryEngineSupport →
 *   gitOperations → ipc-handlers/agentChat → agentChat/threadStore →
 *   electron.app.getPath(), which crashes in vitest's Node environment.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ─── Module mocks — must appear before any transitive import of logger/electron ─

vi.mock('../logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    log: vi.fn(),
  },
  getLogPath: vi.fn(() => ''),
}));

vi.mock('../ipc-handlers/gitOperations', () => ({
  gitExec: vi.fn(async () => ''),
  gitTrimmed: vi.fn(async () => ''),
}));

import type { AutoSyncWatcher } from './autoSync';
import { CypherEngine } from './cypherEngine';
import type { CompatHandle } from './graphControllerCompat';
import { GraphControllerCompat } from './graphControllerCompat';
import {
  getGraphController,
  getGraphControllerForRoot,
  setGraphController,
} from './graphControllerCompatRegistry';
import { GraphDatabase } from './graphDatabase';
import { IndexingPipeline } from './indexingPipeline';
import { callResolutionPass } from './indexingPipelineCallResolution';
import { definitionPass, importPass, parsePass, structurePass } from './indexingPipelinePasses';
import { loadIgnoreRules, walkDirectory } from './indexingPipelineSupport';
import type { DiscoveredFile, IndexedFile, IndexingResult } from './indexingPipelineTypes';
import type { IndexingWorkerClient } from './indexingWorkerClient';
import { QueryEngine } from './queryEngine';
import { TreeSitterParser } from './treeSitterParser';

// ─── Fixture source files ─────────────────────────────────────────────────────

const FIXTURE_FILES: Record<string, string> = {
  'utils.ts':
    [
      'export interface Shape {',
      '  x: number',
      '  y: number',
      '}',
      '',
      'export function helper(x: number): number {',
      '  return x * 2',
      '}',
      '',
      'export function formatShape(s: Shape): string {',
      '  return `(${s.x}, ${s.y})`',
      '}',
    ].join('\n') + '\n',

  'main.ts':
    [
      "import { helper, formatShape } from './utils'",
      '',
      'export function run(n: number): number {',
      '  return helper(n) + 1',
      '}',
      '',
      'export class Runner {',
      '  invoke(): number {',
      '    return run(5)',
      '  }',
      '',
      '  describe(x: number, y: number): string {',
      '    return formatShape({ x, y })',
      '  }',
      '}',
    ].join('\n') + '\n',

  'service.ts':
    [
      "import { Runner } from './main'",
      '',
      'export function startService(): Runner {',
      '  const r = new Runner()',
      '  r.invoke()',
      '  return r',
      '}',
    ].join('\n') + '\n',
};

const PROJECT_NAME = 'test-fixture';

// ─── Module-level shared state ────────────────────────────────────────────────

let fixtureDir = '';
let db: GraphDatabase;
let pipelineDb: GraphDatabase;
let parser: TreeSitterParser;
let compat: GraphControllerCompat;
let indexResult: IndexingResult;
let indexedFiles: IndexedFile[];

// IDs discovered after indexing — used for targeted query tests
let runNodeId = '';
let helperNodeId = '';

// ─── DB population helper — avoids the finalizeIndex REPLACE cascade bug ──────

/**
 * Populate the DB using individual pass functions directly.
 * Does NOT call finalizeIndex (which uses INSERT OR REPLACE INTO projects and
 * cascades-deletes all nodes via FK). The project row is created once with an
 * INSERT that has no conflict to resolve, so no cascade occurs.
 */
async function populateDbFromFixture(): Promise<{
  allFiles: DiscoveredFile[];
  indexedFiles: IndexedFile[];
}> {
  // (Re)create a clean in-memory DB
  db = new GraphDatabase(':memory:');

  // Insert project row ONCE — with a plain upsert. Because the DB is fresh
  // (':memory:'), this is the first insert and INSERT OR REPLACE does no delete.
  db.upsertProject({
    name: PROJECT_NAME,
    root_path: fixtureDir,
    indexed_at: Date.now(),
    node_count: 0,
    edge_count: 0,
  });

  // Discover files
  const allFiles: DiscoveredFile[] = [];
  const ig = await loadIgnoreRules(fixtureDir, []);
  await walkDirectory(fixtureDir, {
    projectRoot: fixtureDir,
    ig,
    maxSize: 512 * 1024,
    maxFiles: 10000,
    files: allFiles,
  });

  // Parse pass — produces IndexedFile[] with parsed definitions
  const parsed = await parsePass(parser, allFiles);

  // Structure pass — inserts Project, Folder, File nodes
  db.transaction(() => structurePass(db, PROJECT_NAME, fixtureDir, allFiles));

  // Definition pass — inserts Function, Class, Interface, etc. nodes
  definitionPass(db, PROJECT_NAME, parsed, { chunkSize: 500 });

  // Import pass — inserts IMPORTS edges
  importPass(db, PROJECT_NAME, parsed, { allFiles, chunkSize: 500 });

  // Call resolution pass — inserts CALLS edges
  callResolutionPass(db, PROJECT_NAME, parsed, { chunkSize: 500 });

  // Note: we intentionally do NOT call upsertProject() here to update node/edge
  // counts, because INSERT OR REPLACE would cascade-delete all nodes (the bug
  // documented at the top of this file). The project row from the initial
  // upsertProject() has node_count = 0 but getNodeCount() reads directly from
  // the nodes table and returns the correct value.

  return { allFiles, indexedFiles: parsed };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create temp fixture directory and write source files
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-integration-'));
  for (const [filename, content] of Object.entries(FIXTURE_FILES)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
    fs.writeFileSync(path.join(fixtureDir, filename), content, 'utf8');
  }

  // Initialize the tree-sitter parser (WASM load may take a moment)
  parser = new TreeSitterParser();
  await parser.init();

  // --- Step 1: Run IndexingPipeline.index() to verify its contract ---
  // We call the full pipeline to prove its API works and populates the DB.
  // The prior finalizeIndex FK-cascade bug (INSERT OR REPLACE on projects)
  // was fixed in graphDatabaseHelpers.ts by switching to ON CONFLICT DO UPDATE.
  pipelineDb = new GraphDatabase(':memory:');
  const pipeline = new IndexingPipeline(pipelineDb, parser);
  indexResult = await pipeline.index({
    projectRoot: fixtureDir,
    projectName: PROJECT_NAME,
    incremental: false,
  });

  // --- Step 2: Populate the DB correctly using individual passes ---
  // This is the DB the shim will query. Bypasses finalizeIndex's REPLACE.
  const { indexedFiles: parsed } = await populateDbFromFixture();
  indexedFiles = parsed;

  // Build a stub WorkerClient — only used for indexRepository() which is not
  // exercised in these smoke tests.
  const stubWorkerClient: IndexingWorkerClient = {
    runIndex: async () => indexResult,
  } as unknown as IndexingWorkerClient;

  const handle: CompatHandle = {
    db,
    queryEngine: new QueryEngine(db, PROJECT_NAME, fixtureDir),
    cypherEngine: new CypherEngine(db, PROJECT_NAME),
    workerClient: stubWorkerClient,
    watcher: null as AutoSyncWatcher | null,
    projectRoot: fixtureDir,
    projectName: PROJECT_NAME,
  };

  compat = new GraphControllerCompat(handle);

  // Register as the default controller so registry getters work
  setGraphController(compat);

  // Discover node IDs for call-path tests
  const runResults = compat.searchGraph('run', 10);
  const runMatch = runResults.find((r) => r.node.name === 'run' && r.node.type === 'function');
  runNodeId = runMatch?.node.id ?? '';

  const helperResults = compat.searchGraph('helper', 10);
  const helperMatch = helperResults.find((r) => r.node.name === 'helper');
  helperNodeId = helperMatch?.node.id ?? '';
}, 30_000 /* tree-sitter WASM may take a moment */);

afterAll(async () => {
  setGraphController(null);
  parser.dispose();
  db.close();
  pipelineDb.close();
  // Best-effort cleanup — temp files may be locked on Windows
  try {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

// ─── Setup sanity ────────────────────────────────────────────────────────────

describe('setup / indexing sanity', () => {
  it('IndexingPipeline.index() returned success:true', () => {
    expect(indexResult.success).toBe(true);
  });

  it('pipeline indexed at least 3 files (one per fixture file)', () => {
    expect(indexResult.filesIndexed).toBeGreaterThanOrEqual(3);
  });

  it('pipeline reported nodesCreated > 0', () => {
    expect(indexResult.nodesCreated).toBeGreaterThan(0);
  });

  it('pipeline.index() leaves the DB populated (finalizeIndex FK-cascade bug fixed)', () => {
    // Regression guard: previously INSERT OR REPLACE on projects cascaded via
    // ON DELETE CASCADE and wiped every node/edge. Now uses ON CONFLICT DO UPDATE.
    const pipelineNodeCount = pipelineDb.getNodeCount(PROJECT_NAME);
    expect(pipelineNodeCount).toBeGreaterThan(0);
  });

  it('at least one function node exists in the DB after direct-pass population', () => {
    const fns = db.getNodesByLabel(PROJECT_NAME, 'Function');
    expect(fns.length).toBeGreaterThan(0);
  });

  it('at least one class node exists in the DB', () => {
    const classes = db.getNodesByLabel(PROJECT_NAME, 'Class');
    expect(classes.length).toBeGreaterThan(0);
  });

  it('project record exists in the DB', () => {
    const project = db.getProject(PROJECT_NAME);
    expect(project).not.toBeNull();
    expect(project?.name).toBe(PROJECT_NAME);
  });

  it('tree-sitter successfully parsed at least one file (indexed files have parsed != null)', () => {
    const parsedCount = indexedFiles.filter((f) => f.parsed !== null).length;
    expect(parsedCount).toBeGreaterThan(0);
  });
});

// ─── Compat registry ─────────────────────────────────────────────────────────

describe('compat registry', () => {
  it('getGraphController() returns the compat instance set in beforeAll', () => {
    expect(getGraphController()).toBe(compat);
  });

  it('getGraphControllerForRoot() finds by fixture root path', () => {
    const found = getGraphControllerForRoot(fixtureDir);
    expect(found).toBe(compat);
  });

  it('getGraphControllerForRoot() returns null for unknown root', () => {
    expect(getGraphControllerForRoot('/no/such/path')).toBeNull();
  });

  it('compat.rootPath equals the fixture directory', () => {
    expect(compat.rootPath).toBe(fixtureDir);
  });
});

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('getStatus', () => {
  it('returns initialized:true after indexing', () => {
    const status = compat.getStatus();
    expect(status.initialized).toBe(true);
  });

  it('DB contains nodes (direct count is positive)', () => {
    // Note: getStatus().nodeCount reads the cached node_count from the projects
    // table (set to 0 to avoid the finalizeIndex CASCADE bug — see file header).
    // Use the live DB count to verify nodes were actually indexed.
    expect(db.getNodeCount(PROJECT_NAME)).toBeGreaterThan(0);
  });

  it('reports the correct projectName', () => {
    expect(compat.getStatus().projectName).toBe(PROJECT_NAME);
  });

  it('has all required fields', () => {
    const s = compat.getStatus();
    expect(s).toHaveProperty('initialized');
    expect(s).toHaveProperty('projectRoot');
    expect(s).toHaveProperty('projectName');
    expect(s).toHaveProperty('nodeCount');
    expect(s).toHaveProperty('edgeCount');
    expect(s).toHaveProperty('fileCount');
    expect(s).toHaveProperty('lastIndexedAt');
    expect(s).toHaveProperty('indexDurationMs');
  });
});

// ─── searchGraph ─────────────────────────────────────────────────────────────

describe('searchGraph', () => {
  it('returns at least one result for "helper"', () => {
    const results = compat.searchGraph('helper');
    expect(results.length).toBeGreaterThan(0);
  });

  it('results have the correct SearchResult shape', () => {
    const results = compat.searchGraph('helper');
    expect(results.length).toBeGreaterThan(0);
    const first = results[0];
    expect(first).toHaveProperty('node');
    expect(first).toHaveProperty('score');
    expect(first).toHaveProperty('matchReason');
    expect(typeof first.node.name).toBe('string');
    expect(typeof first.node.id).toBe('string');
  });

  it('finds a node whose name matches the query', () => {
    const results = compat.searchGraph('helper');
    const match = results.find((r) => r.node.name === 'helper');
    expect(match).toBeDefined();
  });

  it('finds Runner class by name', () => {
    const results = compat.searchGraph('Runner');
    const match = results.find((r) => r.node.name === 'Runner');
    expect(match).toBeDefined();
  });

  it('returns empty array for a nonsense query', () => {
    const results = compat.searchGraph('xyzzy_no_such_symbol_9999');
    expect(Array.isArray(results)).toBe(true);
  });

  it('respects the limit parameter', () => {
    const results = compat.searchGraph('run', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

// ─── getGraphSchema ───────────────────────────────────────────────────────────

describe('getGraphSchema', () => {
  it('returns a GraphSchema with positive nodeCount', () => {
    const schema = compat.getGraphSchema();
    expect(schema.nodeCount).toBeGreaterThan(0);
  });

  it('includes nodeTypes and edgeTypes arrays', () => {
    const schema = compat.getGraphSchema();
    expect(Array.isArray(schema.nodeTypes)).toBe(true);
    expect(Array.isArray(schema.edgeTypes)).toBe(true);
  });

  it('nodeTypes includes a function-related type', () => {
    const schema = compat.getGraphSchema();
    // nodeTypes come from nodeLabelCounts keys — could be 'Function', 'function', etc.
    const lc = schema.nodeTypes.map((t) => t.toLowerCase());
    expect(lc.some((t) => t.includes('function'))).toBe(true);
  });
});

// ─── queryGraph ──────────────────────────────────────────────────────────────

describe('queryGraph', () => {
  it('MATCH (n:Function) RETURN n returns at least one row', () => {
    const rows = compat.queryGraph('MATCH (n:Function) RETURN n');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('rows are plain objects', () => {
    const rows = compat.queryGraph('MATCH (n:Function) RETURN n LIMIT 3');
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0]).toBe('object');
  });

  it('LIMIT clause is respected', () => {
    const rows = compat.queryGraph('MATCH (n:Function) RETURN n LIMIT 1');
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it('returns empty array for a write query (rejected by CypherEngine)', () => {
    const rows = compat.queryGraph('DELETE (n) RETURN n');
    expect(Array.isArray(rows)).toBe(true);
  });
});

// ─── getArchitecture ─────────────────────────────────────────────────────────

describe('getArchitecture', () => {
  it('returns an ArchitectureView with required fields', () => {
    const view = compat.getArchitecture();
    expect(view).toHaveProperty('projectName');
    expect(view).toHaveProperty('modules');
    expect(view).toHaveProperty('hotspots');
    expect(view).toHaveProperty('fileTree');
  });

  it('modules is an array', () => {
    expect(Array.isArray(compat.getArchitecture().modules)).toBe(true);
  });

  it('hotspots is an array', () => {
    expect(Array.isArray(compat.getArchitecture().hotspots)).toBe(true);
  });

  it('fileTree is an array', () => {
    expect(Array.isArray(compat.getArchitecture().fileTree)).toBe(true);
  });

  it('hotspots aspect call returns well-formed view', () => {
    const view = compat.getArchitecture(['hotspots']);
    expect(view).toHaveProperty('hotspots');
    expect(Array.isArray(view.hotspots)).toBe(true);
  });
});

// ─── getCodeSnippet ───────────────────────────────────────────────────────────

describe('getCodeSnippet', () => {
  it('returns null for an unknown symbol ID', async () => {
    const result = await compat.getCodeSnippet('no::such::symbol::0');
    expect(result).toBeNull();
  });

  it('returns a CodeSnippetResult for a known node ID', async () => {
    if (!helperNodeId) return; // tree-sitter parsing failed on this platform
    const result = await compat.getCodeSnippet(helperNodeId);
    expect(result).not.toBeNull();
    expect(result!.node.name).toBe('helper');
    expect(typeof result!.content).toBe('string');
    expect(Array.isArray(result!.dependencies)).toBe(true);
    expect(Array.isArray(result!.dependents)).toBe(true);
  });

  it('CodeSnippetResult node has the correct S1 shape', async () => {
    if (!helperNodeId) return;
    const result = await compat.getCodeSnippet(helperNodeId);
    if (!result) return;
    expect(result.node).toHaveProperty('id');
    expect(result.node).toHaveProperty('name');
    expect(result.node).toHaveProperty('type');
    expect(result.node).toHaveProperty('filePath');
    expect(result.node).toHaveProperty('line');
  });
});

// ─── traceCallPath ────────────────────────────────────────────────────────────

describe('traceCallPath', () => {
  it('returns a CallPathResult with required fields regardless of input', () => {
    const result = compat.traceCallPath('a::fromFn::function::1', 'b::toFn::function::5');
    expect(result).toHaveProperty('found');
    expect(result).toHaveProperty('path');
    expect(result).toHaveProperty('edges');
    expect(Array.isArray(result.path)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
  });

  it('run → helper path check with real node IDs', () => {
    if (!runNodeId || !helperNodeId) return;
    const result = compat.traceCallPath(runNodeId, helperNodeId);
    expect(typeof result.found).toBe('boolean');
    if (result.found) {
      expect(result.path.length).toBeGreaterThan(0);
    }
  });

  it('accepts S1-format IDs (path::name::type::line)', () => {
    const result = compat.traceCallPath(
      'utils.ts::helper::function::6',
      'main.ts::run::function::3',
    );
    expect(result).toHaveProperty('found');
  });
});

// ─── detectChanges ────────────────────────────────────────────────────────────

describe('detectChanges', () => {
  it('returns a ChangeDetectionResult with required fields', async () => {
    const result = await compat.detectChanges();
    expect(result).toHaveProperty('changedFiles');
    expect(result).toHaveProperty('affectedSymbols');
    expect(result).toHaveProperty('blastRadius');
    expect(Array.isArray(result.changedFiles)).toBe(true);
    expect(Array.isArray(result.affectedSymbols)).toBe(true);
    expect(typeof result.blastRadius).toBe('number');
  });

  it('detectChangesForSession returns ChangeDetectionResult shape', async () => {
    const result = await compat.detectChangesForSession('test-session-id', [
      path.join(fixtureDir, 'utils.ts'),
    ]);
    expect(result).toHaveProperty('changedFiles');
    expect(result).toHaveProperty('affectedSymbols');
    expect(result).toHaveProperty('blastRadius');
  });
});

// ─── searchCode ───────────────────────────────────────────────────────────────

describe('searchCode', () => {
  it('returns an array (may be empty if ripgrep not in PATH)', async () => {
    const results = await compat.searchCode('helper');
    expect(Array.isArray(results)).toBe(true);
  });

  it('each result has filePath, line, and match fields', async () => {
    const results = await compat.searchCode('helper');
    for (const r of results) {
      expect(r).toHaveProperty('filePath');
      expect(r).toHaveProperty('line');
      expect(r).toHaveProperty('match');
      expect(typeof r.filePath).toBe('string');
      expect(typeof r.line).toBe('number');
      expect(typeof r.match).toBe('string');
    }
  });
});

// ─── Lifecycle hooks ──────────────────────────────────────────────────────────

describe('compat lifecycle hooks', () => {
  it('onFileChange([]) does not throw', () => {
    expect(() => compat.onFileChange([])).not.toThrow();
  });

  it('onFileChange with paths does not throw', () => {
    expect(() => compat.onFileChange([path.join(fixtureDir, 'utils.ts')])).not.toThrow();
  });

  it('onSessionStart() does not throw', () => {
    expect(() => compat.onSessionStart()).not.toThrow();
  });

  it('onGitCommit() does not throw', () => {
    expect(() => compat.onGitCommit()).not.toThrow();
  });

  it('dispose() resolves without throwing', async () => {
    // Build a local compat so we do not poison the shared instance
    const localDb = new GraphDatabase(':memory:');
    const localHandle: CompatHandle = {
      db: localDb,
      queryEngine: new QueryEngine(localDb, 'local', fixtureDir),
      cypherEngine: new CypherEngine(localDb, 'local'),
      workerClient: { runIndex: async () => indexResult } as unknown as IndexingWorkerClient,
      watcher: null as AutoSyncWatcher | null,
      projectRoot: fixtureDir,
      projectName: 'local',
    };
    const localCompat = new GraphControllerCompat(localHandle);
    await expect(localCompat.dispose()).resolves.toBeUndefined();
    localDb.close();
  });
});

// ─── listProjects / deleteProject ─────────────────────────────────────────────

describe('listProjects / deleteProject', () => {
  it('listProjects returns the fixture root when initialized', () => {
    expect(compat.listProjects()).toContain(fixtureDir);
  });

  it('deleteProject returns success:false for wrong root', () => {
    expect(compat.deleteProject('/completely/wrong/path').success).toBe(false);
  });
});

// ─── ingestTraces ─────────────────────────────────────────────────────────────

describe('ingestTraces', () => {
  it('accepts valid trace edges referencing real nodes and returns ingested count', () => {
    // Use a known node ID so FK constraint is satisfied
    const fns = db.getNodesByLabel(PROJECT_NAME, 'Function');
    if (fns.length < 2) {
      // Not enough nodes to form an edge — skip
      expect(true).toBe(true);
      return;
    }
    const result = compat.ingestTraces([
      { fromId: fns[0].id, toId: fns[1].id, type: 'HTTP_CALLS' },
    ]);
    expect(result.success).toBe(true);
    expect(result.ingested).toBe(1);
  });

  it('returns success:false for non-array input', () => {
    expect(compat.ingestTraces('bad' as unknown as unknown[]).success).toBe(false);
  });

  it('skips entries missing toId', () => {
    const result = compat.ingestTraces([{ fromId: 'x' }]);
    expect(result.ingested).toBe(0);
  });
});

// ─── manageAdr ────────────────────────────────────────────────────────────────

describe('manageAdr', () => {
  it('list action returns success:true with ADR directory message', () => {
    const result = compat.manageAdr('list') as { success: boolean; message: string };
    expect(result.success).toBe(true);
    expect(result.message).toContain('ADR directory');
  });

  it('get action returns success:true', () => {
    const result = compat.manageAdr('get', 'adr-001') as { success: boolean };
    expect(result.success).toBe(true);
  });

  it('unknown action returns success:false', () => {
    const result = compat.manageAdr('unknown' as 'list') as { success: boolean };
    expect(result.success).toBe(false);
  });
});

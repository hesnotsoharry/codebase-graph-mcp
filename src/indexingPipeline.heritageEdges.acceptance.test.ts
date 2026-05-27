/**
 * indexingPipeline.heritageEdges.acceptance.test.ts
 *
 * Wave 21 Phase 1 — orchestrator-owned boundary acceptance test.
 *
 * Pins the contract for IMPLEMENTS and EXTENDS edge emission via tree-sitter
 * `class_heritage` extraction in `definitionPass`. The implementer (Phase 1
 * sonnet-implementer) may NOT modify this test — it is authored by the
 * orchestrator before dispatch, per
 * `~/.claude/rules-deferred/orchestrator-owned-acceptance-tests.md`.
 *
 * Contract:
 *   - A class with `extends Base implements IA, IB` and Base/IA/IB defined
 *     in the same project emits exactly:
 *       1 EXTENDS edge: Foo -> Base
 *       2 IMPLEMENTS edges: Foo -> IA, Foo -> IB
 *   - A class with `implements UnknownExternal` where UnknownExternal is NOT a
 *     node in the project graph emits zero IMPLEMENTS edges for that reference
 *     (Wave 21 Decision 4: skip on unresolved target — mirrors Wave 19
 *     callResolutionPass filterEdges safety net).
 *   - A plain class with no heritage clause emits zero EXTENDS / IMPLEMENTS
 *     edges (existing behavior preserved; no spurious emission).
 *
 * Failure mode against pre-Phase-1 code: the indexer does not walk
 * `class_heritage` children; `ExtractedDefinition` has no heritage fields;
 * `definitionPass` emits no IMPLEMENTS or EXTENDS edges. Every assertion below
 * fails.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ─── Module mocks — must precede transitive imports of logger/electron ────────

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

import { GraphDatabase } from './graphDatabase';
import { IndexingPipeline } from './indexingPipeline';
import type { IndexingResult } from './indexingPipelineTypes';
import { TreeSitterParser } from './treeSitterParser';

// ─── Fixture: a TS file with three heritage shapes ────────────────────────────

const FIXTURE_CONTENT = [
  'export interface IA {',
  '  doA(): void;',
  '}',
  '',
  'export interface IB {',
  '  doB(): number;',
  '}',
  '',
  'export class Base {',
  '  baseMethod(): void {}',
  '}',
  '',
  '// Class with extends + multiple implements — the primary contract case.',
  'export class Foo extends Base implements IA, IB {',
  '  doA(): void {}',
  '  doB(): number { return 42; }',
  '}',
  '',
  '// Class implementing an interface that is NOT in the project graph.',
  '// Per Wave 21 Decision 4, the IMPLEMENTS edge to UnknownExternal must be',
  '// SKIPPED (no FK violation, no orphan edge).',
  'export class WithExternal implements UnknownExternal {',
  '  externalMethod(): void {}',
  '}',
  '',
  '// Plain class — no heritage. Must produce zero IMPLEMENTS/EXTENDS edges.',
  'export class Plain {',
  '  plainMethod(): void {}',
  '}',
  '',
  '// Forward-declared symbol used only as an external-implements target.',
  '// Intentionally not declared in this file. The TS source compiles in the',
  '// sense the indexer cares about — tree-sitter parses it regardless of TS',
  '// type-checker errors. The indexer must not emit an edge to it.',
  'declare const UnknownExternal: unknown;',
].join('\n') + '\n';

const PROJECT_NAME = 'wave-21-heritage-acceptance';
const FILE_QN_PREFIX = `${PROJECT_NAME}.heritage-fixture`;

// ─── Shared state ─────────────────────────────────────────────────────────────

let fixtureDir = '';
let db: GraphDatabase;
let result: IndexingResult;

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-21-heritage-'));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
  fs.writeFileSync(path.join(fixtureDir, 'heritage-fixture.ts'), FIXTURE_CONTENT, 'utf8');

  const parser = new TreeSitterParser();
  await parser.init();

  db = new GraphDatabase(':memory:');
  const pipeline = new IndexingPipeline(db, parser);

  result = await pipeline.index({
    projectRoot: fixtureDir,
    projectName: PROJECT_NAME,
    incremental: false,
  });
}, 30_000);

afterAll(() => {
  try { db?.close(); } catch { /* best-effort */ }
  try {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }
});

// ─── Sanity: pipeline ran cleanly and parsed the fixture ──────────────────────

describe('Wave 21 — boundary acceptance: heritage edge emission', () => {
  it('pipeline.index() completes successfully', () => {
    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBeGreaterThan(0);
  });

  it('the four expected classes are indexed as Class nodes', () => {
    const classNodes = db.getNodesByLabel(PROJECT_NAME, 'Class');
    const classNames = classNodes.map((n) => n.name);
    expect(classNames).toEqual(expect.arrayContaining(['Foo', 'Base', 'WithExternal', 'Plain']));
  });

  it('the two expected interfaces are indexed as Interface nodes', () => {
    const interfaceNodes = db.getNodesByLabel(PROJECT_NAME, 'Interface');
    const interfaceNames = interfaceNodes.map((n) => n.name);
    expect(interfaceNames).toEqual(expect.arrayContaining(['IA', 'IB']));
  });

  // ─── Primary contract: Foo extends Base implements IA, IB ─────────────────

  it('Foo emits exactly one EXTENDS edge targeting Base', () => {
    const fooQn = `${FILE_QN_PREFIX}.Foo`;
    const baseQn = `${FILE_QN_PREFIX}.Base`;
    const extendsEdges = db.getOutboundEdges(fooQn, 'EXTENDS');
    expect(extendsEdges).toHaveLength(1);
    expect(extendsEdges[0].target_id).toBe(baseQn);
  });

  it('Foo emits exactly two IMPLEMENTS edges targeting IA and IB', () => {
    const fooQn = `${FILE_QN_PREFIX}.Foo`;
    const iaQn = `${FILE_QN_PREFIX}.IA`;
    const ibQn = `${FILE_QN_PREFIX}.IB`;
    const implementsEdges = db.getOutboundEdges(fooQn, 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(2);
    const targets = implementsEdges.map((e) => e.target_id).sort();
    expect(targets).toEqual([iaQn, ibQn].sort());
  });

  // ─── Skip-on-unresolved contract: WithExternal -> UnknownExternal ─────────

  it('WithExternal emits zero IMPLEMENTS edges (external target unresolved)', () => {
    const externalQn = `${FILE_QN_PREFIX}.WithExternal`;
    const implementsEdges = db.getOutboundEdges(externalQn, 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(0);
  });

  it('WithExternal emits zero EXTENDS edges (no extends clause)', () => {
    const externalQn = `${FILE_QN_PREFIX}.WithExternal`;
    const extendsEdges = db.getOutboundEdges(externalQn, 'EXTENDS');
    expect(extendsEdges).toHaveLength(0);
  });

  // ─── No-heritage contract: Plain emits no heritage edges ──────────────────

  it('Plain class emits zero EXTENDS and zero IMPLEMENTS edges', () => {
    const plainQn = `${FILE_QN_PREFIX}.Plain`;
    expect(db.getOutboundEdges(plainQn, 'EXTENDS')).toHaveLength(0);
    expect(db.getOutboundEdges(plainQn, 'IMPLEMENTS')).toHaveLength(0);
  });

  // ─── Global contract: no dangling heritage edges anywhere in the DB ──────

  it('no IMPLEMENTS or EXTENDS edge in the DB points to a non-existent target', () => {
    const heritageEdges = [
      ...(db.rawQuery(
        "SELECT source_id, target_id, type FROM edges WHERE project = ? AND type IN ('IMPLEMENTS', 'EXTENDS')",
        [PROJECT_NAME],
      ) as Array<{ source_id: string; target_id: string; type: string }>),
    ];

    // Build the set of all node IDs in the project for the dangling check.
    const allNodeIds = new Set(
      (db.rawQuery('SELECT id FROM nodes WHERE project = ?', [PROJECT_NAME]) as Array<{ id: string }>)
        .map((r) => r.id),
    );

    const dangling = heritageEdges.filter(
      (e) => !allNodeIds.has(e.source_id) || !allNodeIds.has(e.target_id),
    );
    expect(dangling).toEqual([]);
  });

  it('the total IMPLEMENTS edge count in the project is exactly 2 (only Foo -> IA, IB)', () => {
    const count = (db.rawQuery(
      "SELECT COUNT(*) AS n FROM edges WHERE project = ? AND type = 'IMPLEMENTS'",
      [PROJECT_NAME],
    ) as Array<{ n: number }>)[0].n;
    expect(count).toBe(2);
  });

  it('the total EXTENDS edge count in the project is exactly 1 (only Foo -> Base)', () => {
    const count = (db.rawQuery(
      "SELECT COUNT(*) AS n FROM edges WHERE project = ? AND type = 'EXTENDS'",
      [PROJECT_NAME],
    ) as Array<{ n: number }>)[0].n;
    expect(count).toBe(1);
  });
});

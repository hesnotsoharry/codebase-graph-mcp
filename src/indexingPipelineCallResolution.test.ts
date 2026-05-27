/**
 * indexingPipelineCallResolution.test.ts — Phase B confidence emission tests.
 *
 * Each test exercises a distinct resolution path and asserts the emitted
 * CALLS edge confidence falls within the expected range from the calibration
 * table in roadmap/wave-80-edge-confidence/phase-a-calibration.md.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GraphDatabase } from './graphDatabase';
import type { GraphNode } from './graphDatabaseTypes';
import { callResolutionPass } from './indexingPipelineCallResolution';
import type { IndexedFile } from './indexingPipelineTypes';
import type { ExtractedCall, ExtractedDefinition, ExtractedImport } from './treeSitterTypes';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT = 'test-project';

function makeNode(overrides: Partial<GraphNode>): GraphNode {
  const id = overrides.id ?? `${PROJECT}.src.utils.fn`;
  return {
    id,
    project: PROJECT,
    label: 'Function',
    name: 'fn',
    qualified_name: id,
    file_path: 'src/utils.ts',
    start_line: 1,
    end_line: 10,
    props: { is_exported: true, is_entry_point: false },
    ...overrides,
  };
}

function makeDef(name: string, startLine = 1, endLine = 20): ExtractedDefinition {
  return {
    name,
    kind: 'Function',
    signature: null,
    returnType: null,
    startLine,
    endLine,
    isExported: true,
    isDefault: false,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    decorators: [],
    receiver: null,
    constants: [],
  };
}

function makeCall(calleeName: string, startLine = 5, isNewExpression = false): ExtractedCall {
  return {
    calleeName,
    receiverName: null,
    startLine,
    isAsync: false,
    arguments: 0,
    isNewExpression,
  };
}

function makeImport(source: string, localName: string, originalName?: string): ExtractedImport {
  return {
    source,
    specifiers: [{ name: localName, originalName: originalName ?? localName, isDefault: false, isNamespace: false }],
    isTypeOnly: false,
    startLine: 1,
    endLine: 1,
  };
}

function makeFile(relativePath: string, defs: ExtractedDefinition[], calls: ExtractedCall[], imports: ExtractedImport[] = []): IndexedFile {
  return {
    absolutePath: `/repo/${relativePath}`,
    relativePath,
    extension: 'ts',
    sizeBytes: 100,
    mtimeMs: Date.now(),
    contentHash: 'deadbeef',
    parsed: {
      filePath: relativePath,
      language: 'typescript',
      lineCount: 20,
      definitions: defs,
      imports,
      calls,
      routes: [],
      exportedNames: defs.map((d) => d.name),
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('callResolutionPass — confidence emission', () => {
  let db: GraphDatabase;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    db.upsertProject({
      name: PROJECT,
      root_path: '/repo',
      indexed_at: Date.now(),
      node_count: 0,
      edge_count: 0,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Path 1: Import-resolved ──────────────────────────────────────────────

  it('emits confidence ~0.95 for import-resolved calls', () => {
    const callerQn = `${PROJECT}.src.main.main`;
    const targetId = `${PROJECT}.src.utils.parseConfig`;
    db.insertNodes([
      makeNode({ id: callerQn, qualified_name: callerQn, name: 'main', file_path: 'src/main.ts' }),
      makeNode({ id: targetId, qualified_name: targetId, name: 'parseConfig', file_path: 'src/utils.ts' }),
    ]);

    const files: IndexedFile[] = [
      makeFile(
        'src/main.ts',
        [makeDef('main')],
        [makeCall('parseConfig')],
        [makeImport('./utils', 'parseConfig')],
      ),
    ];

    callResolutionPass(db, PROJECT, files);

    const edges = db.getOutboundEdges(callerQn, 'CALLS');
    expect(edges).toHaveLength(1);
    expect(edges[0].confidence).toBeGreaterThanOrEqual(0.9);
    expect(edges[0].confidence).toBeLessThanOrEqual(1.0);
  });

  // ─── Path 2: Same-file definition ────────────────────────────────────────

  it('emits confidence ~0.85 for same-file definition resolution', () => {
    const callerQn = `${PROJECT}.src.utils.processItem`;
    const targetQn = `${PROJECT}.src.utils.helper`;
    db.insertNodes([
      makeNode({ id: callerQn, qualified_name: callerQn, name: 'processItem', file_path: 'src/utils.ts' }),
      makeNode({ id: targetQn, qualified_name: targetQn, name: 'helper', file_path: 'src/utils.ts' }),
    ]);

    const files: IndexedFile[] = [
      makeFile(
        'src/utils.ts',
        [makeDef('processItem', 1, 10), makeDef('helper', 12, 20)],
        [makeCall('helper', 5)],
      ),
    ];

    callResolutionPass(db, PROJECT, files);

    const edges = db.getOutboundEdges(callerQn, 'CALLS');
    expect(edges).toHaveLength(1);
    expect(edges[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(edges[0].confidence).toBeLessThanOrEqual(0.9);
  });

  // ─── Path 3: Single global match (name-unique) ────────────────────────────

  it('emits confidence ~0.80 for name-unique global resolution', () => {
    const callerQn = `${PROJECT}.src.consumer.consume`;
    const targetId = `${PROJECT}.src.lib.uniqueFn`;
    db.insertNodes([
      makeNode({ id: callerQn, qualified_name: callerQn, name: 'consume', file_path: 'src/consumer.ts' }),
      makeNode({ id: targetId, qualified_name: targetId, name: 'uniqueFn', file_path: 'src/lib.ts' }),
    ]);

    const files: IndexedFile[] = [
      makeFile(
        'src/consumer.ts',
        [makeDef('consume')],
        [makeCall('uniqueFn')],
      ),
    ];

    callResolutionPass(db, PROJECT, files);

    const edges = db.getOutboundEdges(callerQn, 'CALLS');
    expect(edges).toHaveLength(1);
    expect(edges[0].confidence).toBeGreaterThanOrEqual(0.75);
    expect(edges[0].confidence).toBeLessThanOrEqual(0.85);
  });

  // ─── Path 4: New-expression class disambiguation ──────────────────────────

  it('emits confidence ~0.65 for new-expression class disambiguation', () => {
    const callerQn = `${PROJECT}.src.factory.create`;
    const classId1 = `${PROJECT}.src.a.MyClass`;
    const classId2 = `${PROJECT}.src.b.MyClass`;
    db.insertNodes([
      makeNode({ id: callerQn, qualified_name: callerQn, name: 'create', file_path: 'src/factory.ts' }),
      makeNode({ id: classId1, qualified_name: classId1, name: 'MyClass', label: 'Class', file_path: 'src/a.ts' }),
      makeNode({ id: classId2, qualified_name: classId2, name: 'MyClass', label: 'Class', file_path: 'src/b.ts' }),
    ]);

    const files: IndexedFile[] = [
      makeFile(
        'src/factory.ts',
        [makeDef('create')],
        [makeCall('MyClass', 5, true)],
      ),
    ];

    callResolutionPass(db, PROJECT, files);

    const edges = db.getOutboundEdges(callerQn, 'CALLS');
    expect(edges).toHaveLength(1);
    expect(edges[0].confidence).toBeGreaterThanOrEqual(0.6);
    expect(edges[0].confidence).toBeLessThanOrEqual(0.7);
  });

  // ─── No edge: ambiguous collision, non-new-expression ────────────────────

  it('emits no edge when name has multiple candidates and is not a new-expression', () => {
    const callerQn = `${PROJECT}.src.caller.caller`;
    const id1 = `${PROJECT}.src.a.ambiguous`;
    const id2 = `${PROJECT}.src.b.ambiguous`;
    db.insertNodes([
      makeNode({ id: callerQn, qualified_name: callerQn, name: 'caller', file_path: 'src/caller.ts' }),
      makeNode({ id: id1, qualified_name: id1, name: 'ambiguous', label: 'Function', file_path: 'src/a.ts' }),
      makeNode({ id: id2, qualified_name: id2, name: 'ambiguous', label: 'Function', file_path: 'src/b.ts' }),
    ]);

    const files: IndexedFile[] = [
      makeFile(
        'src/caller.ts',
        [makeDef('caller')],
        [makeCall('ambiguous')],
      ),
    ];

    callResolutionPass(db, PROJECT, files);

    const edges = db.getOutboundEdges(callerQn, 'CALLS');
    expect(edges).toHaveLength(0);
  });
});

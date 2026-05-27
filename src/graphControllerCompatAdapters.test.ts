/**
 * graphControllerCompatAdapters.test.ts — Shape conformance tests for
 * the System2→System1 translators in graphControllerCompatAdapters.ts.
 */

import { describe, expect, it } from 'vitest';

import {
  toSystem1ArchitectureView,
  toSystem1CallPathResult,
  toSystem1ChangeDetectionResult,
  toSystem1ChangeDetectionResultFromSession,
  toSystem1CodeSnippetResult,
  toSystem1GraphEdge,
  toSystem1GraphNode,
  toSystem1GraphSchema,
  toSystem1NodeId,
  toSystem1SearchResult,
  toSystem2NodeId,
} from './graphControllerCompatAdapters';
import type { GraphEdge as S2GraphEdge, GraphNode as S2GraphNode } from './graphDatabaseTypes';
import type { DetectChangesResult, GraphSchemaResult, TraceResult } from './queryEngineTypes';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeS2Node(overrides: Partial<S2GraphNode> = {}): S2GraphNode {
  return {
    id: 'Agent IDE.src/main/foo.ts.myFn',
    project: 'Agent IDE',
    label: 'Function',
    name: 'myFn',
    qualified_name: 'Agent IDE.src/main/foo.ts.myFn',
    file_path: 'src/main/foo.ts',
    start_line: 10,
    end_line: 20,
    props: { is_exported: true },
    ...overrides,
  };
}

function makeS2Edge(overrides: Partial<S2GraphEdge> = {}): S2GraphEdge {
  return {
    id: 1,
    project: 'Agent IDE',
    source_id: 'src/main/foo.ts::myFn::function::10',
    target_id: 'src/main/bar.ts::otherFn::function::5',
    type: 'CALLS',
    props: {},
    ...overrides,
  };
}

// ─── toSystem1NodeId ──────────────────────────────────────────────────────────

describe('toSystem1NodeId', () => {
  it('produces S1 format: path::name::type::line', () => {
    const node = makeS2Node();
    const id = toSystem1NodeId(node);
    expect(id).toBe('src/main/foo.ts::myFn::function::10');
  });

  it('uses __unknown__ when file_path is null', () => {
    const id = toSystem1NodeId(makeS2Node({ file_path: null }));
    expect(id).toContain('__unknown__');
  });

  it('maps Class label to class type', () => {
    const id = toSystem1NodeId(makeS2Node({ label: 'Class', name: 'MyClass', start_line: 1 }));
    expect(id).toContain('::class::');
  });

  it('maps Interface to interface', () => {
    const id = toSystem1NodeId(makeS2Node({ label: 'Interface', name: 'IFoo', start_line: 1 }));
    expect(id).toContain('::interface::');
  });

  it('maps Type to type_alias', () => {
    const id = toSystem1NodeId(makeS2Node({ label: 'Type', name: 'MyType', start_line: 1 }));
    expect(id).toContain('::type_alias::');
  });
});

// ─── toSystem2NodeId ─────────────────────────────────────────────────────────

describe('toSystem2NodeId', () => {
  it('returns input unchanged when no "::" present (raw S2 id)', () => {
    const s2Id = 'Agent IDE.src/main/foo.ts.myFn';
    expect(toSystem2NodeId(s2Id, 'Agent IDE')).toBe(s2Id);
  });

  it('returns input unchanged when S1-format id passed', () => {
    const s1Id = 'src/main/foo.ts::myFn::function::10';
    // Round-trip: no DB available, falls back to returning the s1Id
    expect(toSystem2NodeId(s1Id, 'Agent IDE')).toBe(s1Id);
  });
});

// ─── toSystem1GraphNode ───────────────────────────────────────────────────────

describe('toSystem1GraphNode', () => {
  it('produces a valid S1 GraphNode', () => {
    const node = toSystem1GraphNode(makeS2Node());
    expect(node.id).toBe('src/main/foo.ts::myFn::function::10');
    expect(node.type).toBe('function');
    expect(node.name).toBe('myFn');
    expect(node.filePath).toBe('src/main/foo.ts');
    expect(node.line).toBe(10);
    expect(node.endLine).toBe(20);
  });

  it('stores the S2 id in metadata for reverse lookup', () => {
    const node = toSystem1GraphNode(makeS2Node());
    expect(node.metadata?.s2Id).toBe('Agent IDE.src/main/foo.ts.myFn');
  });

  it('handles null file_path gracefully', () => {
    const node = toSystem1GraphNode(makeS2Node({ file_path: null }));
    expect(node.filePath).toBe('');
  });
});

// ─── toSystem1GraphEdge ───────────────────────────────────────────────────────

describe('toSystem1GraphEdge', () => {
  it('maps CALLS edge type to calls', () => {
    const edge = toSystem1GraphEdge(makeS2Edge(), new Map());
    expect(edge.type).toBe('calls');
  });

  it('maps IMPLEMENTS to implements', () => {
    const edge = toSystem1GraphEdge(makeS2Edge({ type: 'IMPLEMENTS' }), new Map());
    expect(edge.type).toBe('implements');
  });

  it('maps EXTENDS to extends', () => {
    const edge = toSystem1GraphEdge(makeS2Edge({ type: 'EXTENDS' }), new Map());
    expect(edge.type).toBe('extends');
  });

  it('maps IMPORTS to imports', () => {
    const edge = toSystem1GraphEdge(makeS2Edge({ type: 'IMPORTS' }), new Map());
    expect(edge.type).toBe('imports');
  });

  it('uses node map for source/target ids when available', () => {
    const srcNode = makeS2Node({ id: 'srcId', file_path: 'a.ts', name: 'a', start_line: 1 });
    const tgtNode = makeS2Node({ id: 'tgtId', file_path: 'b.ts', name: 'b', start_line: 2 });
    const nodeMap = new Map([
      ['srcId', srcNode],
      ['tgtId', tgtNode],
    ]);
    const edge = toSystem1GraphEdge(
      makeS2Edge({ source_id: 'srcId', target_id: 'tgtId' }),
      nodeMap,
    );
    expect(edge.source).toBe(toSystem1NodeId(srcNode));
    expect(edge.target).toBe(toSystem1NodeId(tgtNode));
  });
});

// ─── M3 — toSystem1SearchResult ──────────────────────────────────────────────

describe('toSystem1SearchResult', () => {
  it('assigns score 100 for exact match', () => {
    const result = toSystem1SearchResult(makeS2Node({ name: 'myFn' }), 'myFn');
    expect(result.score).toBe(100);
    expect(result.matchReason).toBe('exact match');
  });

  it('assigns score 80 for prefix match', () => {
    const result = toSystem1SearchResult(makeS2Node({ name: 'myFnHelper' }), 'myFn');
    expect(result.score).toBe(80);
    expect(result.matchReason).toBe('prefix match');
  });

  it('assigns score 60 for substring match', () => {
    const result = toSystem1SearchResult(makeS2Node({ name: 'doMyFnStuff' }), 'myFn');
    expect(result.score).toBe(60);
    expect(result.matchReason).toBe('substring match');
  });

  it('falls back to score 1.0 when no named match', () => {
    const result = toSystem1SearchResult(makeS2Node({ name: 'totallyDifferent' }), 'xyz');
    expect(result.score).toBe(1.0);
  });

  it('returns a node with the correct S1 shape', () => {
    const result = toSystem1SearchResult(makeS2Node(), 'myFn');
    expect(result.node).toHaveProperty('id');
    expect(result.node).toHaveProperty('type');
    expect(result.node).toHaveProperty('name');
    expect(result.node).toHaveProperty('filePath');
    expect(result.node).toHaveProperty('line');
  });
});

// ─── M4 — toSystem1CallPathResult ────────────────────────────────────────────

describe('toSystem1CallPathResult', () => {
  it('returns found:false when TraceResult has no startNode', () => {
    const empty: TraceResult = {
      startNode: null as unknown as TraceResult['startNode'],
      nodes: [],
      edges: [],
      totalNodes: 0,
      truncated: false,
    };
    expect(toSystem1CallPathResult(empty, 'otherFn').found).toBe(false);
  });

  it('returns found:false when toId not in nodes', () => {
    const trace: TraceResult = {
      startNode: {
        id: 'a',
        name: 'fromFn',
        label: 'Function',
        filePath: 'a.ts',
        startLine: 1,
        signature: null,
        depth: 0,
      },
      nodes: [],
      edges: [],
      totalNodes: 0,
      truncated: false,
    };
    expect(toSystem1CallPathResult(trace, 'notThere').found).toBe(false);
  });

  it('returns found:true with path when toId matches a node name', () => {
    const trace: TraceResult = {
      startNode: {
        id: 'a',
        name: 'fromFn',
        label: 'Function',
        filePath: 'a.ts',
        startLine: 1,
        signature: null,
        depth: 0,
      },
      nodes: [
        {
          id: 'b',
          name: 'toFn',
          label: 'Function',
          filePath: 'b.ts',
          startLine: 5,
          signature: null,
          depth: 1,
        },
      ],
      edges: [{ source: 'a', target: 'b', type: 'CALLS' }],
      totalNodes: 1,
      truncated: false,
    };
    const result = toSystem1CallPathResult(trace, 'toFn');
    expect(result.found).toBe(true);
    expect(result.path).toHaveLength(2);
    expect(result.path[0].name).toBe('fromFn');
    expect(result.path[1].name).toBe('toFn');
  });
});

// ─── M2 — toSystem1ArchitectureView ──────────────────────────────────────────

describe('toSystem1ArchitectureView', () => {
  it('produces an ArchitectureView with required fields', () => {
    const result = toSystem1ArchitectureView({
      projectName: 'TestProject',
      aspects: {
        hotspots: 'myFn (degree: 10) -- src/main/foo.ts:10',
        file_tree: '  src/\n  src/main/',
        packages: '',
      },
    });
    expect(result.projectName).toBe('TestProject');
    expect(Array.isArray(result.modules)).toBe(true);
    expect(Array.isArray(result.hotspots)).toBe(true);
    expect(Array.isArray(result.fileTree)).toBe(true);
  });

  it('handles empty aspects gracefully', () => {
    const result = toSystem1ArchitectureView({ projectName: 'X', aspects: {} });
    expect(result.hotspots).toEqual([]);
    expect(result.fileTree).toEqual([]);
  });
});

// ─── M5 — toSystem1ChangeDetectionResult ─────────────────────────────────────

describe('toSystem1ChangeDetectionResult', () => {
  it('maps changedFiles from ChangedFileInfo path', () => {
    const input: DetectChangesResult = {
      changedFiles: [{ path: 'src/a.ts', status: 'modified' }],
      changedSymbols: [],
      impactedCallers: [],
      riskSummary: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    };
    const result = toSystem1ChangeDetectionResult(input);
    expect(result.changedFiles).toEqual(['src/a.ts']);
  });

  it('includes impactedCallers in affectedSymbols', () => {
    const input: DetectChangesResult = {
      changedFiles: [],
      changedSymbols: [{ name: 'myFn', label: 'Function', filePath: 'a.ts', qualifiedName: 'q1' }],
      impactedCallers: [
        {
          name: 'caller',
          label: 'Function',
          filePath: 'b.ts',
          qualifiedName: 'q2',
          depth: 1,
          risk: 'HIGH',
        },
      ],
      riskSummary: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
    };
    const result = toSystem1ChangeDetectionResult(input);
    expect(result.affectedSymbols).toHaveLength(2);
    expect(result.blastRadius).toBe(2);
  });
});

// ─── M5b — toSystem1ChangeDetectionResultFromSession ─────────────────────────

describe('toSystem1ChangeDetectionResultFromSession', () => {
  it('maps changed files and blast radius', () => {
    const result = toSystem1ChangeDetectionResultFromSession({
      changedFiles: ['src/a.ts'],
      affectedSymbols: [
        {
          id: 'q1',
          name: 'fn',
          label: 'Function',
          filePath: 'src/a.ts',
          startLine: 5,
          hopDepth: 0,
        },
      ],
      blastRadius: 1,
    });
    expect(result.changedFiles).toEqual(['src/a.ts']);
    expect(result.affectedSymbols).toHaveLength(1);
    expect(result.blastRadius).toBe(1);
  });
});

// ─── M6 — toSystem1GraphSchema ────────────────────────────────────────────────

describe('toSystem1GraphSchema', () => {
  it('sums counts correctly', () => {
    const input: GraphSchemaResult = {
      nodeLabelCounts: { Function: 50, Class: 20, File: 30 },
      edgeTypeCounts: { CALLS: 100, IMPORTS: 40 },
      relationshipPatterns: [],
      sampleNames: { functions: [], classes: [], qualifiedNames: [] },
    };
    const schema = toSystem1GraphSchema(input);
    expect(schema.nodeCount).toBe(100);
    expect(schema.edgeCount).toBe(140);
    expect(schema.nodeTypes).toEqual(expect.arrayContaining(['Function', 'Class', 'File']));
    expect(schema.edgeTypes).toEqual(expect.arrayContaining(['CALLS', 'IMPORTS']));
  });
});

// ─── M7 — toSystem1CodeSnippetResult ─────────────────────────────────────────

describe('toSystem1CodeSnippetResult', () => {
  it('returns correct shape with node, content, deps, dependents', () => {
    const result = toSystem1CodeSnippetResult(
      'function myFn() {}',
      makeS2Node(),
      ['depA', 'depB'],
      ['depC'],
    );
    expect(result.node.name).toBe('myFn');
    expect(result.content).toBe('function myFn() {}');
    expect(result.dependencies).toEqual(['depA', 'depB']);
    expect(result.dependents).toEqual(['depC']);
  });
});

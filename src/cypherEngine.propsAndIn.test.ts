/**
 * cypherEngine.propsAndIn.test.ts — Wave 68b regression suite.
 *
 * Covers behavior that did not work pre-Wave-68b:
 *   1. Reading props.* keys via Cypher (RETURN n.signature, WHERE n.kind = ..., ORDER BY n.signature)
 *   2. labels(n) IN [...] and n.label IN [...] WHERE filters
 *   3. Strict parser — unsupported WHERE shapes throw rather than silently dropping
 *
 * Pre-Wave-68b status:
 *   - `n.signature` errored with "no such column" because the resolver didn't fall through to props
 *   - `labels(n) IN [...]` silently returned un-filtered rows (parser dropped the condition)
 *   - Any unsupported WHERE shape was silently dropped, masking bugs
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CypherEngine } from './cypherEngine';
import { GraphDatabase } from './graphDatabase';
import type { NodeLabel } from './graphDatabaseTypes';

const PROJECT = 'props-in-test';

interface PropsBlob {
  [key: string]: unknown;
  signature?: string;
  kind?: string;
  visibility?: string;
}

function makeNode(
  id: string,
  label: NodeLabel,
  name: string,
  props: PropsBlob,
): {
  id: string;
  project: string;
  label: NodeLabel;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  props: PropsBlob;
} {
  return {
    id,
    project: PROJECT,
    label,
    name,
    qualified_name: `p.${name}`,
    file_path: `${name}.ts`,
    start_line: 1,
    end_line: 10,
    props,
  };
}

/** Seeds a graph where nodes carry meaningful signature / kind / visibility props. */
function seed(db: GraphDatabase): void {
  db.upsertProject({
    name: PROJECT,
    root_path: '/tmp',
    indexed_at: 1700000000000,
    node_count: 5,
    edge_count: 0,
  });
  db.insertNodes([
    makeNode('cls1', 'Class', 'Widget', {
      signature: 'class Widget extends Component',
      visibility: 'public',
    }),
    makeNode('fn1', 'Function', 'mount', {
      signature: '(target: Element): void',
      kind: 'lifecycle',
    }),
    makeNode('fn2', 'Function', 'render', {
      signature: '(props: Props): VNode',
      kind: 'render',
    }),
    makeNode('fn3', 'Function', 'destroy', {
      signature: '(): void',
      kind: 'lifecycle',
    }),
    makeNode('iface1', 'Interface', 'Props', {
      signature: 'interface Props { id: string }',
      visibility: 'public',
    }),
    makeNode('plain1', 'Function', 'noProps', {}), // exercises null props.* return
  ]);
}

describe('CypherEngine — Wave 68b: props.* fall-through', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seed(db);
    engine = new CypherEngine(db, PROJECT);
  });
  afterEach(() => db.close());

  it('RETURN n.signature reads the props.signature key', () => {
    const result = engine.execute("MATCH (n) WHERE n.name = 'mount' RETURN n.signature");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].n_signature).toBe('(target: Element): void');
  });

  it('RETURN n.signature returns null when the key is absent', () => {
    const result = engine.execute("MATCH (n) WHERE n.name = 'noProps' RETURN n.signature");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].n_signature).toBeNull();
  });

  it('RETURN multi-prop projection: name + signature + kind in one row', () => {
    const result = engine.execute(
      "MATCH (n) WHERE n.name = 'render' RETURN n.name, n.signature, n.kind",
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].n_name).toBe('render');
    expect(result.rows[0].n_signature).toBe('(props: Props): VNode');
    expect(result.rows[0].n_kind).toBe('render');
  });

  it('WHERE n.kind = filters by props key', () => {
    const result = engine.execute("MATCH (n:Function) WHERE n.kind = 'lifecycle' RETURN n.name");
    expect(result.rows.length).toBe(2);
    const names = result.rows.map((r) => r.n_name);
    expect(new Set(names)).toEqual(new Set(['mount', 'destroy']));
  });

  it('WHERE n.signature CONTAINS filters by substring of a props key', () => {
    const result = engine.execute("MATCH (n) WHERE n.signature CONTAINS 'VNode' RETURN n.name");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].n_name).toBe('render');
  });

  it('WHERE n.signature STARTS WITH filters by prefix of a props key', () => {
    const result = engine.execute("MATCH (n) WHERE n.signature STARTS WITH 'class ' RETURN n.name");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].n_name).toBe('Widget');
  });

  it('ORDER BY a props key sorts correctly', () => {
    const result = engine.execute(
      "MATCH (n:Function) WHERE n.kind <> '' RETURN n.name, n.kind ORDER BY n.kind ASC",
    );
    // lifecycle < render alphabetically
    expect(result.rows.length).toBe(3);
    expect(result.rows[0].n_kind).toBe('lifecycle');
    expect(result.rows[2].n_kind).toBe('render');
  });

  it('Mix: real SQL column AND props key in one query', () => {
    const result = engine.execute(
      "MATCH (n:Function) WHERE n.start_line = 1 AND n.kind = 'render' RETURN n.name",
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].n_name).toBe('render');
  });
});

describe('CypherEngine — Wave 68b: IN filter', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seed(db);
    engine = new CypherEngine(db, PROJECT);
  });
  afterEach(() => db.close());

  it('labels(n) IN [...] filters by node label set', () => {
    const result = engine.execute(
      "MATCH (n) WHERE labels(n) IN ['Class', 'Interface'] RETURN n.name",
    );
    expect(result.rows.length).toBe(2);
    const names = result.rows.map((r) => r.n_name);
    expect(new Set(names)).toEqual(new Set(['Widget', 'Props']));
  });

  it('n.label IN [...] is equivalent to labels(n) IN [...]', () => {
    const labelsForm = engine.execute(
      "MATCH (n) WHERE labels(n) IN ['Class', 'Interface'] RETURN n.name",
    );
    const directForm = engine.execute(
      "MATCH (n) WHERE n.label IN ['Class', 'Interface'] RETURN n.name",
    );
    expect(directForm.rows.length).toBe(labelsForm.rows.length);
  });

  it('IN filter applies to props keys (n.kind IN [...])', () => {
    const result = engine.execute(
      "MATCH (n) WHERE n.kind IN ['lifecycle', 'render'] RETURN n.name",
    );
    expect(result.rows.length).toBe(3);
    const names = result.rows.map((r) => r.n_name);
    expect(new Set(names)).toEqual(new Set(['mount', 'render', 'destroy']));
  });

  it('IN filter combined with AND', () => {
    const result = engine.execute(
      "MATCH (n:Function) WHERE n.kind IN ['lifecycle'] AND n.name = 'mount' RETURN n.name",
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].n_name).toBe('mount');
  });

  it('IN with single-element list still applies the filter', () => {
    const result = engine.execute("MATCH (n) WHERE labels(n) IN ['Interface'] RETURN n.name");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].n_name).toBe('Props');
  });

  it('IN with numeric values', () => {
    const result = engine.execute('MATCH (n) WHERE n.start_line IN [1, 99] RETURN count(*)');
    expect(result.rows[0].count).toBe(6); // all six seeded nodes have start_line 1
  });
});

describe('CypherEngine — Wave 68b: parser strictness', () => {
  let db: GraphDatabase;
  let engine: CypherEngine;

  beforeEach(() => {
    db = new GraphDatabase(':memory:');
    seed(db);
    engine = new CypherEngine(db, PROJECT);
  });
  afterEach(() => db.close());

  it('Unsupported WHERE shape throws a descriptive error', () => {
    // Cypher's NOT operator is not supported by the engine.
    expect(() => engine.execute("MATCH (n) WHERE NOT n.name = 'mount' RETURN n.name")).toThrow(
      /Unsupported WHERE condition/,
    );
  });

  it('Mismatched IN syntax throws a descriptive error', () => {
    // Missing closing bracket. Pre-68b this was silently dropped.
    expect(() => engine.execute("MATCH (n) WHERE labels(n) IN ['Class' RETURN n.name")).toThrow(
      /Unsupported WHERE condition/,
    );
  });

  it('Empty WHERE clause is fine (parsed as zero conditions)', () => {
    // No WHERE at all — should not throw.
    const result = engine.execute('MATCH (n:Class) RETURN count(*)');
    expect(result.rows[0].count).toBe(1);
  });
});

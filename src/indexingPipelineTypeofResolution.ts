/**
 * indexingPipelineTypeofResolution.ts — Pass 5.5: typeof / ReturnType edge resolution.
 *
 * Scans TypeScript source files for `typeof X` / `ReturnType<typeof X>` and similar
 * type-level references, emitting TYPEOF_REFERENCES edges in the graph.
 *
 * Captures all 6 typeof patterns from ADR D3:
 *   - typeof X
 *   - ReturnType<typeof X>
 *   - Parameters<typeof X>
 *   - InstanceType<typeof X>
 *   - Awaited<ReturnType<typeof X>>
 *   - keyof typeof X
 *
 * NOTE ON APPROACH: The tree-sitter parser (`treeSitterParser.ts`) frees its
 * parse tree immediately after extraction (see `tree.delete()` in parseFile's
 * `finally` block). The tree is not stored on `ParsedFileResult`. Rather than
 * re-parsing files or modifying the parser, this pass scans source text with
 * regex patterns anchored to the 6 typeof patterns. The patterns are syntactically
 * distinctive in TypeScript type positions and won't appear as valid value-level code.
 *
 * TypeScript-only: typeof in type position has no meaning in plain JS / JSX — skip
 * non-TypeScript files (.ts and .tsx only).
 *
 * Unresolved targets: when the referenced symbol name cannot be resolved to a
 * known node ID (e.g. external lib not in graph), the edge is skipped. This
 * matches callResolutionPass behavior.
 */

import fs from 'node:fs';

import type { GraphDatabase } from './graphDatabase';
import type { GraphEdge } from './graphDatabaseTypes';
import type { IndexedFile } from './indexingPipelineTypes';

// ─── Pattern detection ────────────────────────────────────────────────────────

/**
 * The 6 typeof patterns from ADR D3.
 */
export type TypeofPattern =
  | 'typeof'
  | 'ReturnType<typeof>'
  | 'Parameters<typeof>'
  | 'InstanceType<typeof>'
  | 'Awaited<ReturnType<typeof>>'
  | 'keyof typeof';

export interface TypeofSite {
  symbolName: string;
  startLine: number;
  pattern: TypeofPattern;
  context: string;
}

/**
 * Regex patterns for each of the 6 typeof patterns from ADR D3.
 * Each captures the referenced symbol name in group 1.
 *
 * Ordering matters: more-specific patterns (Awaited<ReturnType<...>>) must
 * appear before their prefixes (ReturnType<...>, typeof) so the first match
 * wins for any given site. The line scanner tries each in order.
 *
 * All patterns use word boundaries (\b) to avoid matching inside longer names.
 * Symbol names are captured as [\w$]+ (identifiers may include $ per JS spec).
 *
 * Type positions where `typeof` appears:
 *   - `type T = typeof X`
 *   - `T extends ReturnType<typeof X>`
 *   - `: ReturnType<typeof X>` in annotations
 *   - `keyof typeof X`
 *   etc.
 */
const TYPEOF_PATTERNS: Array<{ pattern: TypeofPattern; re: RegExp }> = [
  // Awaited<ReturnType<typeof X>> — must come before ReturnType
  {
    pattern: 'Awaited<ReturnType<typeof>>',
    re: /\bAwaited\s*<\s*ReturnType\s*<\s*typeof\s+([\w$]+)/g,
  },
  // ReturnType<typeof X>
  {
    pattern: 'ReturnType<typeof>',
    re: /\bReturnType\s*<\s*typeof\s+([\w$]+)/g,
  },
  // Parameters<typeof X>
  {
    pattern: 'Parameters<typeof>',
    re: /\bParameters\s*<\s*typeof\s+([\w$]+)/g,
  },
  // InstanceType<typeof X>
  {
    pattern: 'InstanceType<typeof>',
    re: /\bInstanceType\s*<\s*typeof\s+([\w$]+)/g,
  },
  // keyof typeof X
  {
    pattern: 'keyof typeof',
    re: /\bkeyof\s+typeof\s+([\w$]+)/g,
  },
  // Plain: typeof X (in type positions — after the above specifics are checked)
  // Use a negative lookbehind for ReturnType/Parameters/InstanceType/Awaited to
  // avoid double-counting, but since we process per-line and earlier patterns
  // are matched first per-line, we just match all remaining `typeof X`.
  {
    pattern: 'typeof',
    re: /\btypeof\s+([\w$]+)/g,
  },
];

/**
 * Extract all typeof sites from a single line of TypeScript source.
 * Tries patterns in specificity order; the same byte range is NOT deduplicated
 * here — the edge deduplication step handles that.
 */
function extractSitesFromLine(
  lineText: string,
  lineNumber: number,
): Array<{ symbolName: string; startLine: number; pattern: TypeofPattern; context: string }> {
  const sites: Array<{
    symbolName: string;
    startLine: number;
    pattern: TypeofPattern;
    context: string;
  }> = [];

  for (const { pattern, re } of TYPEOF_PATTERNS) {
    // Reset lastIndex before each use (global regexes are stateful)
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(lineText)) !== null) {
      const symbolName = match[1];
      if (!symbolName) continue;
      // Context: up to 100 chars of the surrounding line fragment
      const start = Math.max(0, match.index - 10);
      const end = Math.min(lineText.length, match.index + match[0].length + 20);
      const context = lineText.slice(start, end).trim();
      sites.push({ symbolName, startLine: lineNumber, pattern, context });
    }
  }

  return sites;
}

/**
 * Scan TypeScript source text and return all typeof sites.
 * Skips comment lines (// and block comment starts) to reduce false positives.
 */
function scanSourceForTypeof(source: string): TypeofSite[] {
  const sites: TypeofSite[] = [];
  const lines = source.split('\n');
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//')) continue;

    // Strip inline comments before scanning
    const commentIdx = line.indexOf('//');
    const scanLine = commentIdx >= 0 ? line.slice(0, commentIdx) : line;

    const lineSites = extractSitesFromLine(scanLine, i + 1); // 1-based line numbers
    for (const site of lineSites) {
      sites.push(site);
    }
  }

  return sites;
}

// ─── Edge emission ────────────────────────────────────────────────────────────

const TYPESCRIPT_EXTENSIONS = new Set(['ts', 'tsx']);

function buildFileQn(projectName: string, relativePath: string): string {
  return `${projectName}.${relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
}

function readFileSource(file: IndexedFile): string | null {
  try {
    return fs.readFileSync(file.absolutePath, 'utf8');
  } catch {
    return null;
  }
}

function resolveTypeofEdges(
  indexedFiles: IndexedFile[],
  projectName: string,
  symbolsByName: Map<string, string[]>,
  edges: Omit<GraphEdge, 'id'>[],
): void {
  for (const file of indexedFiles) {
    // typeof type patterns only apply in TypeScript files
    if (!TYPESCRIPT_EXTENSIONS.has(file.extension)) continue;
    if (!file.parsed) continue;

    const source = readFileSource(file);
    if (!source) continue;

    const fileQn = buildFileQn(projectName, file.relativePath);
    const sites = scanSourceForTypeof(source);

    for (const site of sites) {
      // Resolve the symbol name to known node IDs
      const candidates = symbolsByName.get(site.symbolName) ?? [];
      if (candidates.length === 0) continue; // Skip unresolved (matches callResolutionPass behavior)

      // If multiple candidates, emit an edge to each (they're all type-level references)
      for (const targetId of candidates) {
        // Avoid self-referencing edges
        if (targetId === fileQn) continue;

        edges.push({
          project: projectName,
          source_id: fileQn,
          target_id: targetId,
          type: 'TYPEOF_REFERENCES',
          props: {
            pattern: site.pattern,
            line: site.startLine,
            context: site.context,
          },
          confidence: 0.9, // High confidence — typeof is explicit syntax, not inferred
        });
      }
    }
  }
}

/**
 * Deduplicate typeof edges, respecting the DB UNIQUE(source_id, target_id, type) constraint.
 *
 * Multiple typeof sites for the same source+target may produce different patterns
 * (e.g. both `typeof useConfig` and `ReturnType<typeof useConfig>` in the same file).
 * The DB can only hold ONE edge per source+target+type triplet (INSERT OR REPLACE).
 *
 * We merge all sites for the same source+target into a single edge whose props.patterns
 * is a deduplicated list of all unique patterns found. The first site's line/context is
 * retained; the patterns array carries all distinct wrapping contexts.
 */
function deduplicateTypeofEdges(edges: Omit<GraphEdge, 'id'>[]): Omit<GraphEdge, 'id'>[] {
  const byKey = new Map<string, { edge: Omit<GraphEdge, 'id'>; patterns: Set<string> }>();

  for (const e of edges) {
    const props = e.props as Record<string, unknown>;
    const pattern = props.pattern as string;
    const key = `${e.source_id}|${e.target_id}`;

    if (!byKey.has(key)) {
      byKey.set(key, {
        edge: { ...e, props: { ...props, patterns: [pattern] } },
        patterns: new Set([pattern]),
      });
    } else {
      byKey.get(key)!.patterns.add(pattern);
      // Keep the merged patterns list in sync
      const merged = byKey.get(key)!;
      (merged.edge.props as Record<string, unknown>).patterns = [...merged.patterns];
    }
  }

  return [...byKey.values()].map(({ edge }) => edge);
}

// ─── Symbol index builder ─────────────────────────────────────────────────────

function buildTypeofSymbolsByName(
  db: GraphDatabase,
  projectName: string,
): Map<string, string[]> {
  const symbolsByName = new Map<string, string[]>();
  // All node types that can be referenced via typeof: functions, classes, variables, etc.
  const allNodes = db
    .getNodesByLabel(projectName, 'Function')
    .concat(db.getNodesByLabel(projectName, 'Method'))
    .concat(db.getNodesByLabel(projectName, 'Class'))
    .concat(db.getNodesByLabel(projectName, 'Variable'))
    .concat(db.getNodesByLabel(projectName, 'Interface'))
    .concat(db.getNodesByLabel(projectName, 'Type'))
    .concat(db.getNodesByLabel(projectName, 'Enum'));

  for (const node of allNodes) {
    const names = symbolsByName.get(node.name) ?? [];
    names.push(node.id);
    symbolsByName.set(node.name, names);
  }
  return symbolsByName;
}

// ─── Public: typeof resolution pass ──────────────────────────────────────────

export function typeofResolutionPass(
  db: GraphDatabase,
  projectName: string,
  _projectRoot: string,
  indexedFiles: IndexedFile[],
): void {
  const symbolsByName = buildTypeofSymbolsByName(db, projectName);
  const validNodeIds = new Set<string>([...symbolsByName.values()].flat());

  const edges: Omit<GraphEdge, 'id'>[] = [];
  resolveTypeofEdges(indexedFiles, projectName, symbolsByName, edges);

  const deduped = deduplicateTypeofEdges(edges);
  // Filter to valid node IDs (target symbol must exist in the graph)
  const filtered = deduped.filter((e) => validNodeIds.has(e.target_id));

  if (filtered.length > 0) {
    db.insertEdges(filtered);
  }
}

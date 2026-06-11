/**
 * mcpToolHandlerTypeof.ts — Handler implementation for the `find_typeof_references` tool.
 *
 * Queries the graph for TYPEOF_REFERENCES edges where the target symbol name
 * matches `symbol_name`. Optionally scoped to `project_name`.
 *
 * Returns a formatted list of { file, line, context, pattern } rows, one per
 * edge, sorted by file path and line number.
 */

import { truncate } from './mcpToolHandlerHelpers';
import type { GraphToolContext } from './mcpToolHandlers';

// ─── find_typeof_references handler ──────────────────────────────────────────

interface TypeofRow {
  file: string;
  line: number;
  context: string;
  pattern: string;
  sourceQn: string;
}

function queryTypeofEdges(
  ctx: GraphToolContext,
  symbolName: string,
  projectName: string | undefined,
): TypeofRow[] {
  const db = ctx.db;
  const project = projectName ?? ctx.projectName;

  // Find all nodes matching the symbol name in the project
  const candidates = db.searchNodes({
    project,
    namePattern: symbolName,
    caseSensitive: true,
    limit: 50,
  });

  const exactMatches = candidates.nodes.filter((n) => n.name === symbolName);
  if (exactMatches.length === 0) return [];

  const rows: TypeofRow[] = [];

  for (const targetNode of exactMatches) {
    // Find all inbound TYPEOF_REFERENCES edges to this node
    const inboundEdges = db.getInboundEdges(targetNode.id, 'TYPEOF_REFERENCES');

    for (const edge of inboundEdges) {
      // Look up the source node to get the file path
      const sourceNode = db.getNode(edge.source_id);
      const props = edge.props as Record<string, unknown>;
      const line = typeof props.line === 'number' ? props.line : 0;
      const context = typeof props.context === 'string' ? props.context : '';
      const pattern = typeof props.pattern === 'string' ? props.pattern : 'typeof';

      rows.push({
        file: sourceNode?.file_path ?? edge.source_id,
        line,
        context,
        pattern,
        sourceQn: edge.source_id,
      });
    }
  }

  // Sort by file path then line number
  rows.sort((a, b) => {
    if (a.file < b.file) return -1;
    if (a.file > b.file) return 1;
    return a.line - b.line;
  });

  return rows;
}

export async function handleFindTypeofReferences(
  ctx: GraphToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    // `symbol` is the canonical param; accept legacy `symbol_name` as a silent alias.
    const symbolName = (args.symbol ?? args.symbol_name) as string | undefined;
    if (!symbolName) return "Error: missing required parameter 'symbol'";

    const projectName = args.project_name as string | undefined;
    const rows = queryTypeofEdges(ctx, symbolName, projectName);

    if (rows.length === 0) {
      return [
        `No TYPEOF_REFERENCES edges found for symbol '${symbolName}'.`,
        '',
        'This means either:',
        `  - No TypeScript files reference '${symbolName}' via typeof/ReturnType<typeof>/etc.`,
        '  - The repository has not been indexed yet (call index_repository first).',
        '  - The symbol name does not exactly match a known graph node.',
      ].join('\n');
    }

    const header = `typeof references to '${symbolName}': ${rows.length} site(s)\n`;
    const tableRows = rows.map(
      (r) =>
        `  ${r.file}:${r.line}  [${r.pattern}]` +
        (r.context ? `  — ${r.context}` : ''),
    );

    return truncate(header + tableRows.join('\n'));
  } catch (err) {
    return `Error finding typeof references: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * mcpToolHandlerSchemaContract.test.ts — Wave 20 Phase C acceptance test.
 *
 * Contract: every property advertised in an MCP tool's input schema must be
 * consumed by the corresponding handler. Schema/handler drift is silently
 * harmful — agents pass params the handler ignores, get unexpected results,
 * and waste cycles debugging.
 *
 * This test asserts the contract for `manage_adr` (the Wave 20 Phase C
 * surgical site). The `id` property was advertised but never consumed; this
 * test pins the post-fix shape.
 */

import { describe, expect, it } from 'vitest';

import { CypherEngine } from './cypherEngine';
import { GraphDatabase } from './graphDatabase';
import type { GraphToolContext } from './mcpToolHandlers';
import { createGraphMcpTools } from './mcpToolHandlers';
import { QueryEngine } from './queryEngine';

function buildContext(): GraphToolContext {
  const db = new GraphDatabase(':memory:');
  const projectName = 'schema-contract-test';
  const queryEngine = new QueryEngine(db, projectName, '/tmp/schema-contract-test');
  const cypherEngine = new CypherEngine(db, projectName);
  return {
    db,
    queryEngine,
    cypherEngine,
    projectName,
  } as GraphToolContext;
}

describe('MCP tool schema/handler contract — manage_adr', () => {
  it('manage_adr schema.properties keys match handler-consumed args', () => {
    const context = buildContext();
    const tools = createGraphMcpTools(context);
    const manageAdr = tools.find((t) => t.name === 'manage_adr');
    expect(manageAdr, 'manage_adr tool must be registered').toBeDefined();
    const schema = manageAdr!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties, 'manage_adr inputSchema must declare properties').toBeDefined();

    // Handler consumes: mode, project, content, sections.
    // Per Wave 20 Decision 4 (Option B) the `id` property is removed from the
    // schema — per-ID targeting was advertised but never wired through.
    const advertisedProps = Object.keys(schema.properties!).sort();
    const handlerConsumedArgs = ['content', 'mode', 'project', 'sections'];
    expect(advertisedProps).toEqual(handlerConsumedArgs);
  });

  it('manage_adr schema does not advertise the orphan `id` property', () => {
    const context = buildContext();
    const tools = createGraphMcpTools(context);
    const manageAdr = tools.find((t) => t.name === 'manage_adr');
    const schema = manageAdr!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty('id');
  });
});

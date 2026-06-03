/**
 * mcpToolHandlers.ts -- MCP tool definitions for the codebase knowledge graph.
 *
 * Exports a `createGraphMcpTools(context)` function that returns 15 McpToolDefinition
 * objects (14 graph tools + ping health-check). M-28 Phase 3 adds find_typeof_references
 * → 16 total. Each handler returns formatted plain text (not JSON), includes qualified
 * names and file:line locations, and truncates output at ~8000 chars.
 *
 * NOTE: file is over the 300-line max-lines limit. The TOOL_SCHEMAS constant
 * (lines ~36-200) is mostly inline JSON-schema declarations; splitting them
 * into a separate module is the natural fix. Tracked as Wave 20 Tier-3
 * follow-up: roadmap/follow-ups/2026-05-26-mcptoolhandlers-over-cap.md.
 */
/* eslint-disable max-lines */
import { textResult } from './types.js';
import { handleDeleteProject, handleGetArchitecture, handleGetCodeSnippet, handleGetGraphSchema, handleIndexRepository, handleIndexStatus, handleIngestTraces, handleListProjects, handleSearchCode, } from './mcpToolHandlerDefs.js';
import { handleDetectChanges, handleManageAdr, handleQueryGraph, handleSearchGraph, handleTraceCallPath, } from './mcpToolHandlerHelpers.js';
import { handleFindTypeofReferences } from './mcpToolHandlerTypeof.js';
// ---- Tool schema definitions --------------------------------------------------
const TOOL_SCHEMAS = {
    index_repository: {
        type: 'object',
        properties: {
            repo_path: {
                type: 'string',
                description: 'Absolute path to the repository root. Defaults to the current workspace.',
            },
        },
        required: [],
    },
    list_projects: { type: 'object', properties: {}, required: [] },
    delete_project: {
        type: 'object',
        properties: { project_name: { type: 'string', description: 'Name of the project to delete.' } },
        required: ['project_name'],
    },
    index_status: {
        type: 'object',
        properties: {
            project: { type: 'string', description: 'Project name. Defaults to current workspace.' },
        },
        required: [],
    },
    search_graph: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Symbol IDENTIFIER (PascalCase/camelCase, no spaces). Substring match. ✓ "ChatWorkbenchArtifactPane", "parseConfig". ✗ "chat workbench artifact pane" returns zero.',
            },
            label: { type: 'string' },
            project: { type: 'string' },
            file_pattern: { type: 'string' },
            relationship: {
                oneOf: [
                    {
                        type: 'string',
                        description: 'Single edge type (e.g. "CALLS") or pipe-delimited union (e.g. "CALLS|ASYNC_CALLS"). Counts edges across all supplied types.',
                    },
                    {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Array form of edge-type union (e.g. ["CALLS","ASYNC_CALLS"]). Equivalent to the pipe-delimited string form.',
                    },
                ],
            },
            direction: { type: 'string', enum: ['inbound', 'outbound', 'both'] },
            min_degree: { type: 'number' },
            max_degree: { type: 'number' },
            exclude_entry_points: { type: 'boolean' },
            case_sensitive: { type: 'boolean' },
            limit: { type: 'number' },
            offset: { type: 'number' },
        },
        required: [],
    },
    get_graph_schema: { type: 'object', properties: {}, required: [] },
    get_architecture: {
        type: 'object',
        properties: {
            aspects: {
                type: 'array',
                items: { type: 'string' },
                description: 'Which aspects: "languages","packages","entry_points","routes","hotspots","boundaries","services","layers","clusters","file_tree","adr","all". Default ["all"]. Pre-refactor: ["hotspots"].',
            },
            project: { type: 'string' },
        },
        required: [],
    },
    search_code: {
        type: 'object',
        properties: {
            pattern: { type: 'string' },
            file_pattern: { type: 'string' },
            regex: { type: 'boolean' },
            case_sensitive: { type: 'boolean' },
            max_results: { type: 'number' },
            offset: { type: 'number' },
        },
        required: ['pattern'],
    },
    get_code_snippet: {
        type: 'object',
        properties: {
            symbol: {
                type: 'string',
                description: 'Symbol IDENTIFIER (PascalCase/camelCase). ✓ "ChatWorkbenchArtifactPane". ✗ "chat workbench artifact pane".',
            },
        },
        required: [],
    },
    trace_call_path: {
        type: 'object',
        properties: {
            symbol: {
                type: 'string',
                description: 'Function/method IDENTIFIER (PascalCase/camelCase). ✓ "parseConfig". ✗ "parse config".',
            },
            direction: {
                type: 'string',
                enum: ['inbound', 'outbound', 'both', 'callers', 'callees'],
                description: "Direction: 'inbound'/'callers' (who calls this); 'outbound'/'callees' (what this calls); 'both' (default).",
            },
            depth: { type: 'number' },
            risk_labels: { type: 'boolean' },
            min_confidence: {
                type: 'number',
                description: 'Filter edges below this confidence (0.0–1.0). Default 0 (no filter). Import-resolved edges ~0.95; name-collision edges ~0.65.',
            },
        },
        required: [],
    },
    detect_changes: {
        type: 'object',
        properties: {
            scope: {
                type: 'string',
                enum: ['unstaged', 'staged', 'all', 'branch'],
                description: '"unstaged"=working-tree vs HEAD; "staged"=index vs HEAD; "all"=both vs HEAD; "branch"=current vs base_branch (requires base_branch).',
            },
            base_branch: {
                type: 'string',
                description: 'Required when scope="branch". Branch to diff against (e.g., "main").',
            },
            depth: { type: 'number' },
            min_confidence: {
                type: 'number',
                description: 'Filter edges below this confidence (0.0–1.0). Default 0 (no filter). See trace_call_path for confidence semantics.',
            },
        },
        required: [],
    },
    query_graph: {
        type: 'object',
        properties: {
            query: { type: 'string' },
            limit: {
                type: 'number',
                description: 'Maximum rows to return per page. Defaults to 200. Use with offset to paginate.',
            },
            offset: {
                type: 'number',
                description: 'Zero-based row offset for pagination. Defaults to 0.',
            },
        },
        required: ['query'],
    },
    manage_adr: {
        type: 'object',
        properties: {
            mode: { type: 'string', enum: ['list', 'get', 'store', 'update', 'delete'] },
            project: { type: 'string' },
            content: { type: 'string' },
            sections: { type: 'object' },
        },
        required: ['mode'],
    },
    ingest_traces: {
        type: 'object',
        properties: {
            traces: {
                type: 'string',
                description: 'JSON-serialized string: JSON.stringify([{ fromId, toId, type, weight? }])',
            },
        },
        required: ['traces'],
    },
    find_typeof_references: {
        type: 'object',
        properties: {
            symbol_name: {
                type: 'string',
                description: 'Symbol IDENTIFIER to find typeof references to (e.g. "useConfig", "MyClass").',
            },
            project_name: {
                type: 'string',
                description: 'Project name to scope the search. Defaults to the current workspace project.',
            },
        },
        required: ['symbol_name'],
    },
    ping: {
        type: 'object',
        properties: {},
        required: [],
    },
};
// ---- Factory helpers ----------------------------------------------------------
// Wrap a Promise<string> into the MCP envelope. Used by simple text-only tools.
async function wrapText(p) {
    return textResult(await p);
}
// Run a Promise<string> handler and surface thrown errors via isError:true.
async function safeText(label, p) {
    try {
        return textResult(await p);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResult(`${label}: ${msg}`, { isError: true });
    }
}
// Run a structured handler (returns Promise<McpToolResult>) with error wrapping.
async function safeStructured(label, p) {
    try {
        return await p;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResult(`${label}: ${msg}`, { isError: true });
    }
}
function buildLifecycleTools(context) {
    return [
        {
            name: 'index_repository',
            description: 'Index a repository into the codebase knowledge graph.',
            inputSchema: TOOL_SCHEMAS.index_repository,
            handler: async (a) => wrapText(handleIndexRepository(a, context)),
        },
        {
            name: 'list_projects',
            description: 'List all indexed projects with node/edge counts and last index time.',
            inputSchema: TOOL_SCHEMAS.list_projects,
            handler: async () => wrapText(handleListProjects(context)),
        },
        {
            name: 'delete_project',
            description: 'Remove a project and all its graph data. Irreversible.',
            inputSchema: TOOL_SCHEMAS.delete_project,
            handler: async (a) => wrapText(handleDeleteProject(a, context)),
        },
        {
            name: 'index_status',
            description: 'Get the current indexing status for a project. Reports node/edge counts by label/type. Always emits a parseAnomalies field (count + files) — zero is a positive signal that indexing produced clean output, not a missing field. Pass project name or omit to use the current workspace.',
            inputSchema: TOOL_SCHEMAS.index_status,
            handler: async (a) => safeStructured('Error getting index status', handleIndexStatus(a, context)),
        },
    ];
}
function buildMetaTools(context) {
    return [
        {
            name: 'get_graph_schema',
            description: 'Graph schema: node/edge counts, relationship patterns, sample names. Call this once at the start of a session involving graph queries to discover what node labels and edge types are available before writing query_graph (Cypher) statements.',
            inputSchema: TOOL_SCHEMAS.get_graph_schema,
            handler: async () => wrapText(handleGetGraphSchema(context)),
        },
        {
            name: 'ingest_traces',
            description: 'Add/strengthen HTTP_CALLS edges. Pass traces as a JSON-serialized string: JSON.stringify([{ fromId, toId, type, weight? }]).',
            inputSchema: TOOL_SCHEMAS.ingest_traces,
            handler: async (a) => wrapText(handleIngestTraces(a, context)),
        },
    ];
}
function buildSearchTools(context) {
    return [
        {
            name: 'search_graph',
            description: 'Symbol search (prefer over Grep). Pass query as the IDENTIFIER (PascalCase/camelCase, no spaces) — natural-language phrases return zero results. ✓ "ChatWorkbenchArtifactPane". ✗ "chat workbench artifact pane". Returns graph nodes with file:line + metadata. Grep returns text matches including comments; search_graph returns actual definitions. The relationship parameter accepts a single edge type ("CALLS"), a pipe-delimited union ("CALLS|ASYNC_CALLS"), or an array (["CALLS","ASYNC_CALLS"]) — degree counts aggregate across all supplied types.',
            inputSchema: TOOL_SCHEMAS.search_graph,
            handler: async (a) => safeText('Error searching graph', handleSearchGraph(a, context)),
        },
        {
            name: 'get_architecture',
            description: 'Use when orienting in unfamiliar code or before a refactor. Returns hotspots (most-connected functions), module structure, and file-tree overview. Cheaper than reading multiple files; tells you where a change has the widest impact.',
            inputSchema: TOOL_SCHEMAS.get_architecture,
            handler: async (a) => safeStructured('Error getting architecture', handleGetArchitecture(a, context)),
        },
        {
            name: 'search_code',
            description: 'String search across source files. Default is SUBSTRING (special chars are escaped); pass regex: true for regex mode. Use for STRING content (error messages, log lines, literal text). For SYMBOL queries (function/class names) prefer search_graph — it filters out comments and same-name false positives.',
            inputSchema: TOOL_SCHEMAS.search_code,
            handler: async (a) => wrapText(handleSearchCode(a, context)),
        },
        {
            name: 'get_code_snippet',
            description: 'Symbol body retrieval (prefer over Read for single symbols). Pass symbol as the IDENTIFIER (PascalCase/camelCase, no spaces). ✓ "parseConfig". ✗ "parse config function". Auto-resolves bare names if unique.',
            inputSchema: TOOL_SCHEMAS.get_code_snippet,
            handler: async (a) => wrapText(handleGetCodeSnippet(a, context)),
        },
    ];
}
function buildTraceAndChangeTools(context) {
    const { queryEngine } = context;
    return [
        {
            name: 'trace_call_path',
            description: "Caller/callee graph (prefer over Grep). Pass symbol as the IDENTIFIER (PascalCase/camelCase, no spaces). ✓ \"parseConfig\". ✗ \"parse config\". direction: 'inbound'/'callers', 'outbound'/'callees', 'both' (default). Returns call edges with risk labels.",
            inputSchema: TOOL_SCHEMAS.trace_call_path,
            handler: async (a) => safeText('Error tracing call path', handleTraceCallPath(a, queryEngine)),
        },
        {
            name: 'detect_changes',
            description: 'Pre-refactor impact analysis. Maps git changes to affected symbols; computes blast radius of what will break.',
            inputSchema: TOOL_SCHEMAS.detect_changes,
            handler: async (a) => safeStructured('Error detecting changes', handleDetectChanges(a, queryEngine)),
        },
    ];
}
function buildCypherAndAdrTools(context) {
    const { cypherEngine } = context;
    return [
        {
            name: 'query_graph',
            description: "Complex relationship queries. Cypher-subset: MATCH (n:Label), (a)-[:TYPE]->(b), (a)-[:TYPE*1..3]->(b), MATCH (n) WITH n WHERE ..., WHERE NOT ()-[:TYPE]->(n); WHERE n.prop {=,<>,<,>,<=,>=,CONTAINS,STARTS WITH,ENDS WITH,IN} AND/OR; RETURN n.prop, COUNT(*), labels(n), DISTINCT; ORDER BY, LIMIT. Node columns: name, qualified_name, file_path, start_line, end_line, label, id, project. Any other property name (e.g. n.signature) falls through to JSON_EXTRACT against the node's props blob. Use labels(n) for the node label string; for set-membership use either `n.label IN ['A','B']` or `labels(n) IN ['A','B']` (or `MATCH (n:Label)`). Defaults to 200 rows per page. Supports limit/offset pagination; response includes truncated:true when more rows exist. Use search_graph for simple symbol lookups. Call get_graph_schema first to discover node labels, edge types, and exact property names.",
            inputSchema: TOOL_SCHEMAS.query_graph,
            handler: async (a) => safeStructured('Query error', handleQueryGraph(a, cypherEngine)),
        },
        {
            name: 'manage_adr',
            description: 'Manage Architecture Decision Records (ADR). Modes: list, get, store, update, delete.',
            inputSchema: TOOL_SCHEMAS.manage_adr,
            handler: async (a) => safeText('Error managing ADR', handleManageAdr(a, context)),
        },
    ];
}
function buildTypeofAndHealthTools(context) {
    return [
        {
            name: 'find_typeof_references',
            description: 'Find all `typeof X` and related type-level references to a symbol. Captures typeof, ReturnType<typeof>, Parameters<typeof>, InstanceType<typeof>, Awaited<ReturnType<typeof>>, and keyof typeof patterns. Use this for refactor-planning when CALLS edges alone miss type-level consumers of a function or class.',
            inputSchema: TOOL_SCHEMAS.find_typeof_references,
            handler: async (a) => wrapText(handleFindTypeofReferences(context, a)),
        },
        {
            name: 'ping',
            description: 'Health-check tool — returns pong. Use to verify the server is running.',
            inputSchema: TOOL_SCHEMAS.ping,
            handler: async () => textResult('pong'),
        },
    ];
}
export function createGraphMcpTools(context) {
    return [
        ...buildLifecycleTools(context),
        ...buildMetaTools(context),
        ...buildSearchTools(context),
        ...buildTraceAndChangeTools(context),
        ...buildCypherAndAdrTools(context),
        ...buildTypeofAndHealthTools(context),
    ];
}
//# sourceMappingURL=mcpToolHandlers.js.map
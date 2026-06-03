export type NodeLabel = 'Project' | 'Package' | 'Folder' | 'File' | 'Module' | 'Function' | 'Method' | 'Class' | 'Interface' | 'Type' | 'Enum' | 'Route' | 'Variable' | 'Export' | 'Test';
export type EdgeType = 'CONTAINS_PACKAGE' | 'CONTAINS_FOLDER' | 'CONTAINS_FILE' | 'DEFINES' | 'DEFINES_METHOD' | 'IMPORTS' | 'CALLS' | 'HTTP_CALLS' | 'ASYNC_CALLS' | 'IMPLEMENTS' | 'HANDLES' | 'USAGE' | 'CONFIGURES' | 'WRITES' | 'MEMBER_OF' | 'TESTS' | 'USES_TYPE' | 'FILE_CHANGES_WITH' | 'EXPORTS' | 'EXTENDS' | 'TYPEOF_REFERENCES' | 'REFERENCES';
/**
 * Exported set of all recognized edge type strings.
 * The acceptance test checks for an exported constant whose name matches
 * /edge.*type/i, /edgekind/i, or /EDGE_TYPES/ containing 'TYPEOF_REFERENCES'.
 *
 * Note: the edges table has no CHECK constraint on the type column (plain TEXT),
 * so no schema migration is needed to add a new edge type — see graphDatabaseSchema.ts.
 */
export declare const EDGE_TYPES: Set<EdgeType>;
export interface BaseNodeProps {
    name: string;
    [key: string]: unknown;
}
export interface ProjectProps extends BaseNodeProps {
    root_path: string;
}
export interface FileProps extends BaseNodeProps {
    path: string;
    language: string;
    line_count: number;
    size_bytes: number;
    content_hash: string;
}
export interface FolderProps extends BaseNodeProps {
    path: string;
}
export interface FunctionProps extends BaseNodeProps {
    signature?: string;
    return_type?: string;
    is_exported: boolean;
    is_entry_point: boolean;
    decorators?: string[];
    is_async?: boolean;
}
export interface MethodProps extends BaseNodeProps {
    signature?: string;
    return_type?: string;
    receiver?: string;
    is_exported: boolean;
    decorators?: string[];
    is_async?: boolean;
    is_static?: boolean;
}
export interface ClassProps extends BaseNodeProps {
    is_exported: boolean;
    is_abstract?: boolean;
    decorators?: string[];
}
export interface InterfaceProps extends BaseNodeProps {
    is_exported: boolean;
}
export interface TypeProps extends BaseNodeProps {
    is_exported: boolean;
}
export interface EnumProps extends BaseNodeProps {
    is_exported: boolean;
}
export interface RouteProps extends BaseNodeProps {
    method: string;
    path: string;
    handler?: string;
}
export interface ModuleProps extends BaseNodeProps {
    constants?: string[];
}
export interface PackageProps extends BaseNodeProps {
    version?: string;
}
export interface GraphNode {
    id: string;
    project: string;
    label: NodeLabel;
    name: string;
    qualified_name: string;
    file_path: string | null;
    start_line: number | null;
    end_line: number | null;
    props: Record<string, unknown>;
}
export interface GraphEdge {
    id: number;
    project: string;
    source_id: string;
    target_id: string;
    type: EdgeType;
    props: Record<string, unknown>;
    confidence?: number;
}
export interface NodeFilter {
    label?: NodeLabel;
    project?: string;
    namePattern?: string;
    filePath?: string;
    minDegree?: number;
    maxDegree?: number;
    relationship?: EdgeType | EdgeType[] | string | string[];
    direction?: 'inbound' | 'outbound' | 'both';
    excludeEntryPoints?: boolean;
    caseSensitive?: boolean;
    limit?: number;
    offset?: number;
}
export interface NodeSearchResult {
    nodes: GraphNode[];
    total: number;
    has_more: boolean;
}
export interface FileHashRecord {
    project: string;
    rel_path: string;
    content_hash: string;
    mtime_ns: number;
    size: number;
}
export interface ProjectRecord {
    name: string;
    root_path: string;
    indexed_at: number;
    node_count: number;
    edge_count: number;
}
/**
 * How a graph edge was resolved. Stored as `props.resolution_method` on every
 * edge written by a resolution pass.
 *
 * Values:
 *   `compiler_api`    — reserved for Wave 2 (ts-morph / tsc type-checked resolution)
 *   `import_resolved` — callee was found by tracing an explicit import statement
 *   `same_file`       — callee is defined in the same file as the caller
 *   `name_unique`     — callee name is unique across the project (single candidate)
 *   `new_expression`  — `new X()` constructor — class node preferred among candidates
 *   `url_literal`     — HTTP_CALLS edge matched by static literal URL path + method
 *   `url_template`    — HTTP_CALLS edge matched by template-literal/param URL path + method
 *   `heuristic_name`  — HTTP_CALLS edge fell back to caller-name / route-path string heuristic
 *   `typeof_regex`    — TYPEOF_REFERENCES edge detected by regex scan of type-position `typeof`
 */
export declare const RESOLUTION_METHODS: readonly ["compiler_api", "import_resolved", "same_file", "name_unique", "new_expression", "url_literal", "url_template", "heuristic_name", "typeof_regex"];
export type ResolutionMethod = (typeof RESOLUTION_METHODS)[number];
export interface ADRRecord {
    project: string;
    summary: string;
    source_hash: string;
    created_at: number;
    updated_at: number;
}
export type ADRSection = 'PURPOSE' | 'STACK' | 'ARCHITECTURE' | 'PATTERNS' | 'TRADEOFFS' | 'PHILOSOPHY';
//# sourceMappingURL=graphDatabaseTypes.d.ts.map
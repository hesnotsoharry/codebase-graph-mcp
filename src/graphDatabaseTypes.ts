// ─── Node Labels ─────────────────────────────────────────────────────────────

export type NodeLabel =
  | 'Project'
  | 'Package'
  | 'Folder'
  | 'File'
  | 'Module'
  | 'Function'
  | 'Method'
  | 'Class'
  | 'Interface'
  | 'Type'
  | 'Enum'
  | 'Route'
  | 'Variable'
  | 'Export';

// ─── Edge Types ──────────────────────────────────────────────────────────────

export type EdgeType =
  | 'CONTAINS_PACKAGE'
  | 'CONTAINS_FOLDER'
  | 'CONTAINS_FILE'
  | 'DEFINES'
  | 'DEFINES_METHOD'
  | 'IMPORTS'
  | 'CALLS'
  | 'HTTP_CALLS'
  | 'ASYNC_CALLS'
  | 'IMPLEMENTS'
  | 'HANDLES'
  | 'USAGE'
  | 'CONFIGURES'
  | 'WRITES'
  | 'MEMBER_OF'
  | 'TESTS'
  | 'USES_TYPE'
  | 'FILE_CHANGES_WITH'
  | 'EXPORTS'
  | 'EXTENDS';

// ─── Node Properties (stored as JSON) ───────────────────────────────────────

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
  method: string; // GET, POST, PUT, DELETE, PATCH
  path: string; // /api/users/:id
  handler?: string; // function name that handles
}

export interface ModuleProps extends BaseNodeProps {
  constants?: string[];
}

export interface PackageProps extends BaseNodeProps {
  version?: string;
}

// ─── Graph Node (as stored in SQLite) ────────────────────────────────────────

export interface GraphNode {
  id: string; // qualified_name (unique)
  project: string; // project name
  label: NodeLabel;
  name: string; // short name
  qualified_name: string; // same as id
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  props: Record<string, unknown>; // JSON properties
}

// ─── Graph Edge (as stored in SQLite) ────────────────────────────────────────

export interface GraphEdge {
  id: number; // auto-increment
  project: string;
  source_id: string; // FK -> nodes.id
  target_id: string; // FK -> nodes.id
  type: EdgeType;
  props: Record<string, unknown>; // JSON properties
  confidence?: number; // 0.0–1.0; omit to use default 1.0 (set explicitly by call-resolution pass)
}

// ─── Query/Filter types ──────────────────────────────────────────────────────

export interface NodeFilter {
  label?: NodeLabel;
  project?: string;
  namePattern?: string; // substring match (case-insensitive)
  filePath?: string; // file path filter
  minDegree?: number; // minimum edge count
  maxDegree?: number; // maximum edge count
  relationship?: EdgeType;
  direction?: 'inbound' | 'outbound' | 'both';
  excludeEntryPoints?: boolean;
  caseSensitive?: boolean;
  limit?: number; // default 100
  offset?: number; // for pagination
}

export interface NodeSearchResult {
  nodes: GraphNode[];
  total: number;
  has_more: boolean;
}

// ─── File hash tracking (incremental reindex) ────────────────────────────────

export interface FileHashRecord {
  project: string;
  rel_path: string;
  content_hash: string;
  mtime_ns: number;
  size: number;
}

// ─── Project metadata ────────────────────────────────────────────────────────

export interface ProjectRecord {
  name: string;
  root_path: string;
  indexed_at: number; // timestamp ms
  node_count: number;
  edge_count: number;
}

// ─── ADR (Architecture Decision Record) ──────────────────────────────────────

export interface ADRRecord {
  project: string;
  summary: string; // JSON string with sections
  source_hash: string;
  created_at: number;
  updated_at: number;
}

export type ADRSection =
  | 'PURPOSE'
  | 'STACK'
  | 'ARCHITECTURE'
  | 'PATTERNS'
  | 'TRADEOFFS'
  | 'PHILOSOPHY';

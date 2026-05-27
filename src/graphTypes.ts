/**
 * graphTypes.ts — Shared types for the internal codebase graph engine.
 */

import type { CypherEngine } from './cypherEngine';
import type { GraphDatabase } from './graphDatabase';
import type { QueryEngine } from './queryEngine';

export interface GraphNode {
  id: string;
  type:
    | 'file'
    | 'function'
    | 'class'
    | 'interface'
    | 'type_alias'
    | 'variable'
    | 'module'
    | 'export';
  name: string;
  filePath: string;
  line: number;
  endLine?: number;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string; // node id
  target: string; // node id
  type: 'imports' | 'exports' | 'calls' | 'contains' | 'implements' | 'extends' | 'depends_on';
  metadata?: Record<string, unknown>;
}

export interface IndexStatus {
  initialized: boolean;
  projectRoot: string;
  projectName: string;
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  lastIndexedAt: number;
  indexDurationMs: number;
}

export interface ArchitectureView {
  projectName: string;
  modules: Array<{ name: string; rootPath: string; fileCount: number; exports: string[] }>;
  hotspots: Array<{ filePath: string; inDegree: number; outDegree: number }>;
  fileTree: Array<{ path: string; type: 'file' | 'directory'; children?: string[] }>;
}

export interface SearchResult {
  node: GraphNode;
  score: number;
  matchReason: string;
}

export interface CallPathResult {
  found: boolean;
  path: GraphNode[];
  edges: GraphEdge[];
}

export interface CodeSnippetResult {
  node: GraphNode;
  content: string;
  dependencies: string[];
  dependents: string[];
}

export interface ChangeDetectionResult {
  changedFiles: string[];
  affectedSymbols: GraphNode[];
  blastRadius: number;
}

export interface GraphSchema {
  nodeTypes: string[];
  edgeTypes: string[];
  nodeCount: number;
  edgeCount: number;
}

export interface GraphToolContext {
  db: GraphDatabase;
  queryEngine: QueryEngine;
  cypherEngine: CypherEngine;
  /** Structural minimum — only .index() is consumed by MCP tool handlers. */
  pipeline: {
    index: (opts: {
      projectRoot: string;
      projectName?: string;
      incremental?: boolean;
      onProgress?: (p: unknown) => void;
    }) => Promise<{
      success: boolean;
      projectName: string;
      filesIndexed: number;
      filesSkipped: number;
      nodesCreated: number;
      edgesCreated: number;
      durationMs: number;
      incremental: boolean;
      errors: string[];
    }>;
  };
  projectRoot: string;
  projectName: string;
}

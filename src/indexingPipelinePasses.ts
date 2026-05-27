/**
 * indexingPipelinePasses.ts — Pass functions extracted from indexingPipeline.ts
 * to keep the main orchestrator under the 300-line limit.
 *
 * Contains: Structure Pass (1), Parse Pass (2), Definition Pass (3), Import Pass (4).
 */

import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { consoleErrorLogger as log } from './loggerInterface';
import { mapConcurrent } from './concurrency';
import type { GraphDatabase } from './graphDatabase';
import type { GraphEdge, GraphNode } from './graphDatabaseTypes';
import { emitHeritageEdges } from './indexingPipelineHeritage';
import {
  buildDefProps,
  buildFileEdges,
  buildFileNodes,
  buildFileQnMap,
  buildFolderEdges,
  buildFolderNodes,
  getOrCreatePackageNode,
  resolveRelativeImport,
} from './indexingPipelineSupport';
import type { DiscoveredFile, IndexedFile } from './indexingPipelineTypes';
import type { TreeSitterParser } from './treeSitterParser';

// ─── Structure Pass (Pass 1) ─────────────────────────────────────────────────

export function structurePass(
  db: GraphDatabase,
  projectName: string,
  projectRoot: string,
  files: DiscoveredFile[],
): void {
  db.insertNode({
    id: projectName,
    project: projectName,
    label: 'Project',
    name: projectName,
    qualified_name: projectName,
    file_path: null,
    start_line: null,
    end_line: null,
    props: { name: projectName, root_path: projectRoot },
  });

  db.insertNodes(buildFolderNodes(projectName, files));
  db.insertEdges(buildFolderEdges(projectName, files));
  db.insertNodes(buildFileNodes(projectName, files));
  db.insertEdges(buildFileEdges(projectName, files));
}

// ─── Parse Pass (Pass 2) ─────────────────────────────────────────────────────

async function readAndParseOne(
  parser: TreeSitterParser,
  file: DiscoveredFile,
): Promise<IndexedFile> {
  let content: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from trusted discovery
    content = await fs.readFile(file.absolutePath, 'utf-8');
  } catch {
    return { ...file, contentHash: '', parsed: null };
  }

  const contentHash = createHash('sha256').update(content).digest('hex');
  let parsed = null;
  try {
    parsed = await parser.parseFile(file.relativePath, content);
  } catch (err) {
    log.warn('[parsePass] parseFile threw, file=%s err=%s', file.relativePath, err instanceof Error ? err.message : String(err));
  }
  return { ...file, contentHash, parsed };
}

export async function parsePass(
  parser: TreeSitterParser,
  files: DiscoveredFile[],
  onProgress?: (processed: number, total: number) => void,
): Promise<IndexedFile[]> {
  let processed = 0;
  const total = files.length;

  return mapConcurrent(files, async (file) => {
    let result: IndexedFile;
    try {
      result = await readAndParseOne(parser, file);
    } catch (err) {
      log.debug('[parsePass] per-file failure, skipping:', file.relativePath, err);
      result = { ...file, contentHash: '', parsed: null };
    }
    processed++;
    if (onProgress && (processed % 50 === 0 || processed === total)) {
      onProgress(processed, total);
    }
    return result;
  });
}

// ─── Definition Pass (Pass 3) ─────────────────────────────────────────────────

type NodeAccumulator = { nodes: GraphNode[]; edges: Omit<GraphEdge, 'id'>[]; projectName: string };

function updateFileProps(db: GraphDatabase, fileQn: string, file: IndexedFile): void {
  const existingFile = db.getNode(fileQn);
  if (!existingFile || !file.parsed) return;
  existingFile.props.line_count = file.parsed.lineCount;
  existingFile.props.content_hash = file.contentHash;
  db.updateNodeProps(fileQn, existingFile.props);
}

function collectDefinitions(file: IndexedFile, fileQn: string, acc: NodeAccumulator): void {
  if (!file.parsed) return;
  for (const def of file.parsed.definitions) {
    const symbolQn = `${fileQn}.${def.name}`;
    acc.nodes.push({
      id: symbolQn,
      project: acc.projectName,
      label: def.kind,
      name: def.name,
      qualified_name: symbolQn,
      file_path: file.relativePath,
      start_line: def.startLine,
      end_line: def.endLine,
      props: buildDefProps(def, file),
    });
    acc.edges.push({
      project: acc.projectName,
      source_id: fileQn,
      target_id: symbolQn,
      type: 'DEFINES',
      props: {},
    });
    if (def.kind === 'Method' && def.receiver) {
      const classQn = `${fileQn}.${def.receiver}`;
      acc.edges.push({
        project: acc.projectName,
        source_id: classQn,
        target_id: symbolQn,
        type: 'DEFINES_METHOD',
        props: {},
      });
    }
  }
}

function addRouteNodes(file: IndexedFile, fileQn: string, acc: NodeAccumulator): void {
  if (!file.parsed) return;
  const { nodes, edges, projectName } = acc;
  for (const route of file.parsed.routes) {
    const routeQn = `${fileQn}.__route_${route.method}_${route.path.replace(/[^a-zA-Z0-9]/g, '_')}`;
    nodes.push({
      id: routeQn,
      project: projectName,
      label: 'Route',
      name: `${route.method} ${route.path}`,
      qualified_name: routeQn,
      file_path: file.relativePath,
      start_line: route.startLine,
      end_line: route.startLine,
      props: {
        name: `${route.method} ${route.path}`,
        method: route.method,
        path: route.path,
        handler: route.handlerName,
      },
    });
    if (route.handlerName) {
      edges.push({
        project: projectName,
        source_id: routeQn,
        target_id: `${fileQn}.${route.handlerName}`,
        type: 'HANDLES',
        props: {},
      });
    }
  }
}

// ─── Chunk helper ────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ─── Definition Pass (Pass 3, continued) ─────────────────────────────────────

/**
 * Pure accumulator: walks parse results for a chunk and returns nodes+edges.
 * No DB access — callers decide what to flush and when.
 */
function collectChunkAccumulator(projectName: string, files: IndexedFile[]): NodeAccumulator {
  const acc: NodeAccumulator = { nodes: [], edges: [], projectName };
  for (const file of files) {
    if (!file.parsed) continue;
    const fileQn = `${projectName}.${file.relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
    collectDefinitions(file, fileQn, acc);
    addRouteNodes(file, fileQn, acc);
  }
  return acc;
}

/**
 * Phase 1 of a chunk: insert nodes + update file props.
 * Must run before phase 2 so all FK targets exist.
 */
function processChunkNodes(db: GraphDatabase, projectName: string, files: IndexedFile[]): void {
  const acc = collectChunkAccumulator(projectName, files);
  for (const file of files) {
    if (!file.parsed) continue;
    const fileQn = `${projectName}.${file.relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
    updateFileProps(db, fileQn, file);
  }
  db.insertNodes(acc.nodes);
}

/**
 * Phase 2 of a chunk: insert edges only.
 * All node FKs are satisfied because phase 1 ran across ALL chunks first.
 */
function processChunkEdges(db: GraphDatabase, projectName: string, files: IndexedFile[]): void {
  const acc = collectChunkAccumulator(projectName, files);
  db.insertEdges(acc.edges);
}

export function definitionPass(
  db: GraphDatabase,
  projectName: string,
  indexedFiles: IndexedFile[],
  options?: { chunkSize?: number },
): void {
  const size = options?.chunkSize;
  if (!size) {
    // Single-chunk (non-chunked) path: nodes first, then edges — same two-phase guarantee.
    const acc = collectChunkAccumulator(projectName, indexedFiles);
    for (const file of indexedFiles) {
      if (!file.parsed) continue;
      const fileQn = `${projectName}.${file.relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
      updateFileProps(db, fileQn, file);
    }
    db.insertNodes(acc.nodes);
    db.insertEdges(acc.edges);
    emitHeritageEdges(db, projectName, indexedFiles);
    return;
  }
  // Chunked path: Phase 1 across all chunks (nodes), then Phase 2 (edges).
  // chunkArray is called ONCE so both phases iterate the same chunk boundaries.
  const chunks = chunkArray(indexedFiles, size);
  for (const chunk of chunks) {
    db.transaction(() => processChunkNodes(db, projectName, chunk));
  }
  for (const chunk of chunks) {
    db.transaction(() => processChunkEdges(db, projectName, chunk));
  }
  // Wave 21: heritage edges land after Phase 2 so all Class/Interface nodes exist.
  emitHeritageEdges(db, projectName, indexedFiles);
}

// ─── Import Pass (Pass 4) ─────────────────────────────────────────────────────

// ─── Import chunk helper ──────────────────────────────────────────────────────

type ImportPassOptions = { allFiles?: DiscoveredFile[]; chunkSize?: number };

function processImportChunk(
  db: GraphDatabase,
  projectName: string,
  files: IndexedFile[],
  fileQnMap: Map<string, string>,
): void {
  const edges: Omit<GraphEdge, 'id'>[] = [];
  for (const file of files) {
    if (!file.parsed) continue;
    const sourceFileQn = `${projectName}.${file.relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
    const fileDir = path.posix.dirname(file.relativePath);
    for (const imp of file.parsed.imports) {
      const targetQn: string | null = imp.source.startsWith('.')
        ? resolveRelativeImport(imp.source, fileDir, fileQnMap)
        : getOrCreatePackageNode(db, projectName, imp.source);
      if (targetQn && targetQn !== sourceFileQn) {
        edges.push({
          project: projectName,
          source_id: sourceFileQn,
          target_id: targetQn,
          type: 'IMPORTS',
          props: { specifiers: imp.specifiers.map((s) => s.name), is_type_only: imp.isTypeOnly },
        });
      }
    }
  }
  db.insertEdges(edges);
}

export function importPass(
  db: GraphDatabase,
  projectName: string,
  indexedFiles: IndexedFile[],
  options?: ImportPassOptions,
): void {
  const fileQnMap = buildFileQnMap(projectName, options?.allFiles ?? indexedFiles);
  const size = options?.chunkSize;
  if (!size) {
    processImportChunk(db, projectName, indexedFiles, fileQnMap);
    return;
  }
  for (const chunk of chunkArray(indexedFiles, size)) {
    db.transaction(() => processImportChunk(db, projectName, chunk, fileQnMap));
  }
}

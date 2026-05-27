/**
 * indexingPipelineStructure.ts — Structure and import pass helpers extracted from
 * indexingPipelineSupport.ts to keep it under the 300-line limit.
 */

import path from 'path';

import type { GraphDatabase } from './graphDatabase';
import type { EdgeType, GraphEdge, GraphNode, NodeLabel } from './graphDatabaseTypes';
import type { DiscoveredFile, IndexedFile } from './indexingPipelineTypes';
import { getLanguageConfig } from './treeSitterLanguageConfigs';

// ─── Structure pass helpers ───────────────────────────────────────────────────

export function buildFolderNodes(projectName: string, files: DiscoveredFile[]): GraphNode[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.relativePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      folders.add(parts.slice(0, i).join('/'));
    }
  }

  const folderNodes: GraphNode[] = [];
  for (const folderPath of folders) {
    const folderName = path.posix.basename(folderPath);
    const qn = `${projectName}.${folderPath.replace(/\//g, '.')}`;
    folderNodes.push({
      id: qn,
      project: projectName,
      label: 'Folder',
      name: folderName,
      qualified_name: qn,
      file_path: folderPath,
      start_line: null,
      end_line: null,
      props: { name: folderName, path: folderPath },
    });
  }
  return folderNodes;
}

export function buildFolderEdges(
  projectName: string,
  files: DiscoveredFile[],
): Omit<GraphEdge, 'id'>[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.relativePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      folders.add(parts.slice(0, i).join('/'));
    }
  }

  const edges: Omit<GraphEdge, 'id'>[] = [];
  for (const folderPath of folders) {
    const parentPath = path.posix.dirname(folderPath);
    const parentQn =
      parentPath === '.' ? projectName : `${projectName}.${parentPath.replace(/\//g, '.')}`;
    const childQn = `${projectName}.${folderPath.replace(/\//g, '.')}`;
    edges.push({
      project: projectName,
      source_id: parentQn,
      target_id: childQn,
      type: 'CONTAINS_FOLDER',
      props: {},
    });
  }
  return edges;
}

export function buildFileNodes(projectName: string, files: DiscoveredFile[]): GraphNode[] {
  return files.map((f) => {
    const qn = `${projectName}.${f.relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
    const langConfig = getLanguageConfig(f.extension);
    return {
      id: qn,
      project: projectName,
      label: 'File' as NodeLabel,
      name: path.posix.basename(f.relativePath),
      qualified_name: qn,
      file_path: f.relativePath,
      start_line: null,
      end_line: null,
      props: {
        name: path.posix.basename(f.relativePath),
        path: f.relativePath,
        language: langConfig?.id ?? 'unknown',
        line_count: 0,
        size_bytes: f.sizeBytes,
        content_hash: '',
      },
    };
  });
}

export function buildFileEdges(
  projectName: string,
  files: DiscoveredFile[],
): Omit<GraphEdge, 'id'>[] {
  return files.map((f) => {
    const folderPath = path.posix.dirname(f.relativePath);
    const parentQn =
      folderPath === '.' ? projectName : `${projectName}.${folderPath.replace(/\//g, '.')}`;
    const fileQn = `${projectName}.${f.relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
    return {
      project: projectName,
      source_id: parentQn,
      target_id: fileQn,
      type: 'CONTAINS_FILE' as EdgeType,
      props: {},
    };
  });
}

// ─── Import pass helpers ──────────────────────────────────────────────────────

export function buildFileQnMap(
  projectName: string,
  files: (DiscoveredFile | IndexedFile)[],
): Map<string, string> {
  const fileQnMap = new Map<string, string>();
  for (const file of files) {
    const qn = `${projectName}.${file.relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
    fileQnMap.set(file.relativePath, qn);
    fileQnMap.set(file.relativePath.replace(/\.[^.]+$/, ''), qn);
    if (file.relativePath.match(/\/index\.[^.]+$/)) {
      fileQnMap.set(file.relativePath.replace(/\/index\.[^.]+$/, ''), qn);
    }
  }
  return fileQnMap;
}

export function resolveRelativeImport(
  importSource: string,
  fileDir: string,
  fileQnMap: Map<string, string>,
): string | null {
  const resolvedPath = path.posix.normalize(path.posix.join(fileDir, importSource));
  let targetQn = fileQnMap.get(resolvedPath) ?? fileQnMap.get(resolvedPath + '/index') ?? null;
  if (!targetQn) {
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs']) {
      targetQn = fileQnMap.get(resolvedPath + '.' + ext) ?? null;
      if (targetQn) break;
    }
  }
  return targetQn;
}

export function getOrCreatePackageNode(
  db: GraphDatabase,
  projectName: string,
  importSource: string,
): string {
  const pkgName = importSource.startsWith('@')
    ? importSource.split('/').slice(0, 2).join('/')
    : importSource.split('/')[0];

  const pkgQn = `${projectName}.__pkg_${pkgName.replace(/[^a-zA-Z0-9]/g, '_')}`;

  if (!db.getNode(pkgQn)) {
    db.insertNode({
      id: pkgQn,
      project: projectName,
      label: 'Package',
      name: pkgName,
      qualified_name: pkgQn,
      file_path: null,
      start_line: null,
      end_line: null,
      props: { name: pkgName },
    });
  }

  return pkgQn;
}

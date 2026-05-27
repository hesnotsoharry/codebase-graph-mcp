/**
 * indexingPipelineSupport.ts — Helper types and functions extracted from
 * indexingPipeline.ts to keep the main file under the 300-line limit.
 */

import { xxh3 } from '@node-rs/xxhash';
import fs from 'fs/promises';
import ignore from 'ignore';
import path from 'path';

import { consoleErrorLogger as log } from './loggerInterface';
import { mapConcurrent } from './concurrency';
import type { DiscoveredFile, IndexedFile } from './indexingPipelineTypes';
import type { ExtractedDefinition } from './treeSitterTypes';

// Re-export structure/import helpers from the split file
export {
  buildFileEdges,
  buildFileNodes,
  buildFileQnMap,
  buildFolderEdges,
  buildFolderNodes,
  getOrCreatePackageNode,
  resolveRelativeImport,
} from './indexingPipelineStructure';

// ─── Hardcoded ignore patterns ────────────────────────────────────────────────

export const ALWAYS_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.context',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  'coverage',
  '.nyc_output',
  '.turbo',
  '.parcel-cache',
  'vendor',
  'target',
  '.vscode',
  '.idea',
  '.fleet',
  'venv',
  '.venv',
  'env',
  '.env',
  '.terraform',
  '.serverless',
]);

export const ALWAYS_IGNORE_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
]);

export const ALWAYS_IGNORE_EXTENSIONS = new Set([
  'map',
  'min.js',
  'min.css',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'ico',
  'webp',
  'bmp',
  'mp3',
  'mp4',
  'wav',
  'avi',
  'mov',
  'mkv',
  'zip',
  'tar',
  'gz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'otf',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'exe',
  'dll',
  'so',
  'dylib',
  'o',
  'obj',
  'pyc',
  'pyo',
  'class',
  'db',
  'sqlite',
  'sqlite3',
  'wasm',
]);

// ─── Skip-path predicate (used by GC and incremental reindex) ─────────────────

/** Pattern matching `.claude/worktrees/` subtrees — indexing these creates stale hotspot noise. */
const WORKTREE_RE = /[/\\]\.claude[/\\]worktrees[/\\]/;

/**
 * Returns true when an absolute or relative file path should never be indexed.
 * Combines ALWAYS_IGNORE_DIRS segment membership with the worktree path regex.
 */
export function isPathSkipped(filePath: string): boolean {
  if (WORKTREE_RE.test(filePath)) return true;
  const segments = filePath.replace(/\\/g, '/').split('/');
  return segments.some((seg) => ALWAYS_IGNORE_DIRS.has(seg));
}

// ─── .gitignore / .cbmignore loading ─────────────────────────────────────────

export async function loadIgnoreRules(
  projectRoot: string,
  extraIgnores: string[],
): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from trusted projectRoot
    const gitignoreContent = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf-8');
    ig.add(gitignoreContent);
  } catch {
    /* no .gitignore */
  }

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from trusted projectRoot
    const cbmIgnore = await fs.readFile(path.join(projectRoot, '.cbmignore'), 'utf-8');
    ig.add(cbmIgnore);
  } catch {
    /* no .cbmignore */
  }

  if (extraIgnores.length > 0) ig.add(extraIgnores);
  return ig;
}

// ─── Directory walker ─────────────────────────────────────────────────────────

export interface WalkContext {
  projectRoot: string;
  ig: ReturnType<typeof ignore>;
  maxSize: number;
  maxFiles: number;
  files: DiscoveredFile[];
}

/**
 * Returns true when `resolved` is inside `projectRoot`.
 * Uses case-insensitive comparison on Windows to account for drive-letter casing.
 */
function isInsideProjectRoot(resolved: string, projectRoot: string): boolean {
  const prefix = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
  if (process.platform === 'win32') {
    return resolved.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return resolved.startsWith(prefix);
}

/**
 * Resolves a symlink entry.  Returns:
 *   - { kind: 'dir' | 'file', resolved } when the target is inside the project root.
 *   - null when the target is outside the root, dangling, or cannot be resolved.
 *
 * Logs a structured warning for symlinks that escape the project root.
 */
async function resolveSymlink(
  entry: import('fs').Dirent,
  fullPath: string,
  projectRoot: string,
): Promise<{ kind: 'dir' | 'file'; resolved: string } | null> {
  let resolved: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fullPath derived from trusted walker path
    resolved = await fs.realpath(fullPath);
  } catch {
    // Dangling symlink — skip silently.
    return null;
  }

  if (!isInsideProjectRoot(resolved, projectRoot)) {
    log.warn('[indexer] skipped symlink outside project root', {
      name: entry.name,
      resolved,
      projectRoot,
    });
    return null;
  }

  // Determine the kind from the resolved target via lstat on the real path.
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved is a real path confirmed inside projectRoot
    const stat = await fs.stat(resolved);
    const kind = stat.isDirectory() ? 'dir' : 'file';
    return { kind, resolved };
  } catch {
    return null;
  }
}

async function processDirectory(
  name: string,
  relPath: string,
  fullPath: string,
  ctx: WalkContext,
): Promise<void> {
  if (ALWAYS_IGNORE_DIRS.has(name)) return;
  if (ctx.ig.ignores(relPath + '/')) return;
  await walkDirectoryImpl(fullPath, ctx);
}

async function processFile(
  name: string,
  relPath: string,
  fullPath: string,
  ctx: WalkContext,
): Promise<void> {
  if (ALWAYS_IGNORE_FILES.has(name)) return;
  const ext = path.extname(name).slice(1).toLowerCase();
  if (ALWAYS_IGNORE_EXTENSIONS.has(ext)) return;
  if (ctx.ig.ignores(relPath)) return;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fullPath built from trusted projectRoot
    const stat = await fs.stat(fullPath);
    if (stat.size > ctx.maxSize || stat.size === 0) return;
    ctx.files.push({
      absolutePath: fullPath,
      relativePath: relPath,
      extension: ext,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  } catch {
    /* stat failed, skip */
  }
}

/**
 * Splits a raw `readdir` result into `dirs` and `fileEntries`, resolving any
 * symlinks with a project-root containment check before classifying them.
 */
async function classifyEntries(
  entries: import('fs').Dirent[],
  dir: string,
  projectRoot: string,
): Promise<{ dirs: import('fs').Dirent[]; fileEntries: import('fs').Dirent[] }> {
  const dirs: import('fs').Dirent[] = [];
  const fileEntries: import('fs').Dirent[] = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      const fullPath = path.join(dir, entry.name);
      const target = await resolveSymlink(entry, fullPath, projectRoot);
      if (target === null) continue;
      if (target.kind === 'dir') {
        dirs.push(entry);
      } else {
        fileEntries.push(entry);
      }
    } else if (entry.isDirectory()) {
      dirs.push(entry);
    } else if (entry.isFile()) {
      fileEntries.push(entry);
    }
  }

  return { dirs, fileEntries };
}

async function walkDirectoryImpl(dir: string, ctx: WalkContext): Promise<void> {
  if (ctx.files.length >= ctx.maxFiles) return;

  let entries: import('fs').Dirent[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir built from trusted projectRoot
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const { dirs, fileEntries } = await classifyEntries(entries, dir, ctx.projectRoot);

  // Batch fs.stat for all files in this directory concurrently.
  await mapConcurrent(fileEntries, async (entry) => {
    if (ctx.files.length >= ctx.maxFiles) return;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(ctx.projectRoot, fullPath).replace(/\\/g, '/');
    await processFile(entry.name, relPath, fullPath, ctx);
  });

  // Recurse into subdirectories sequentially to honour maxFiles cap correctly.
  for (const entry of dirs) {
    if (ctx.files.length >= ctx.maxFiles) break;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(ctx.projectRoot, fullPath).replace(/\\/g, '/');
    await processDirectory(entry.name, relPath, fullPath, ctx);
  }
}

export async function walkDirectory(dir: string, ctx: WalkContext): Promise<void> {
  await walkDirectoryImpl(dir, ctx);
}

// ─── Content hashing ─────────────────────────────────────────────────────────

export async function hashFileContent(filePath: string): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath from trusted discovery
  const content = await fs.readFile(filePath);
  // xxh3 128-bit: ~3-5× faster than SHA-256; 128-bit avoids birthday collisions at 50k+ files
  return xxh3.xxh128(content).toString(16).padStart(32, '0');
}

// ─── Definition pass helpers ──────────────────────────────────────────────────

const ENTRY_DECORATORS = new Set([
  'Get', 'Post', 'Put', 'Delete', 'Patch',
  'Controller', 'Injectable', 'Component', 'Module', 'Resolver', 'Middleware',
]);

export function isEntryPoint(def: ExtractedDefinition, file: IndexedFile): boolean {
  if (def.name === 'main') return true;
  if (def.decorators.some((d) => ENTRY_DECORATORS.has(d))) return true;
  if (/\.(test|spec)\.[^.]+$/.test(file.relativePath)) return true;
  if (def.isDefault && /\/index\.[^.]+$/.test(file.relativePath)) return true;
  return false;
}

export function buildDefProps(
  def: ExtractedDefinition,
  file: IndexedFile,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    name: def.name,
    is_exported: def.isExported,
  };
  if (def.signature) props.signature = def.signature;
  if (def.returnType) props.return_type = def.returnType;
  if (def.isAsync) props.is_async = true;
  if (def.isStatic) props.is_static = true;
  if (def.isAbstract) props.is_abstract = true;
  if (def.decorators.length > 0) props.decorators = def.decorators;
  if (def.receiver) props.receiver = def.receiver;
  if (def.kind === 'Function' || def.kind === 'Method') {
    props.is_entry_point = isEntryPoint(def, file);
  }
  return props;
}

// ─── Import pass helpers ──────────────────────────────────────────────────────

export interface FileQnMap {
  map: Map<string, string>;
}

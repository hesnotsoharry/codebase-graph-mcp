/**
 * indexingPipelineSupport.test.ts — Tests for ignore constants and walker helpers.
 */

import fs from 'fs/promises';
import ignore from 'ignore';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WalkContext } from './indexingPipelineSupport';
import {
  ALWAYS_IGNORE_DIRS,
  ALWAYS_IGNORE_EXTENSIONS,
  ALWAYS_IGNORE_FILES,
  hashFileContent,
  walkDirectory,
} from './indexingPipelineSupport';

// ─── hashFileContent (xxhash3-128) ────────────────────────────────────────────

describe('hashFileContent', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xxhash-test-'));
    tmpFile = path.join(tmpDir, 'test.txt');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns a 32-char hex string for known content (regression vector)', async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
    await fs.writeFile(tmpFile, 'hello', 'utf-8');
    const hash = await hashFileContent(tmpFile);
    // Deterministic xxh3-128 result for "hello" — lock regression value
    expect(hash).toBe('b5e9c1ad071b3e7fc779cfaa5e523818');
    expect(hash).toHaveLength(32);
  });

  it('returns the same hash for identical content on repeated calls', async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
    await fs.writeFile(tmpFile, 'deterministic content', 'utf-8');
    const h1 = await hashFileContent(tmpFile);
    const h2 = await hashFileContent(tmpFile);
    expect(h1).toBe(h2);
  });

  it('returns different hashes for different content', async () => {
    const fileA = path.join(tmpDir, 'a.txt');
    const fileB = path.join(tmpDir, 'b.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
    await fs.writeFile(fileA, 'content A', 'utf-8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write to os.tmpdir()
    await fs.writeFile(fileB, 'content B', 'utf-8');
    const hA = await hashFileContent(fileA);
    const hB = await hashFileContent(fileB);
    expect(hA).not.toBe(hB);
  });
});

// ─── ALWAYS_IGNORE_DIRS ───────────────────────────────────────────────────────

describe('ALWAYS_IGNORE_DIRS', () => {
  it('contains the baseline dirs', () => {
    expect(ALWAYS_IGNORE_DIRS.has('node_modules')).toBe(true);
    expect(ALWAYS_IGNORE_DIRS.has('.git')).toBe(true);
    expect(ALWAYS_IGNORE_DIRS.has('dist')).toBe(true);
    expect(ALWAYS_IGNORE_DIRS.has('build')).toBe(true);
    expect(ALWAYS_IGNORE_DIRS.has('out')).toBe(true);
  });

  it('contains .next (Next.js output)', () => {
    expect(ALWAYS_IGNORE_DIRS.has('.next')).toBe(true);
  });

  it('contains .turbo (Turborepo cache)', () => {
    expect(ALWAYS_IGNORE_DIRS.has('.turbo')).toBe(true);
  });

  it('contains coverage (test coverage output)', () => {
    expect(ALWAYS_IGNORE_DIRS.has('coverage')).toBe(true);
  });

  it('contains .nuxt', () => {
    expect(ALWAYS_IGNORE_DIRS.has('.nuxt')).toBe(true);
  });

  it('contains __pycache__', () => {
    expect(ALWAYS_IGNORE_DIRS.has('__pycache__')).toBe(true);
  });
});

// ─── ALWAYS_IGNORE_FILES ──────────────────────────────────────────────────────

describe('ALWAYS_IGNORE_FILES', () => {
  it('ignores lock files', () => {
    expect(ALWAYS_IGNORE_FILES.has('package-lock.json')).toBe(true);
    expect(ALWAYS_IGNORE_FILES.has('yarn.lock')).toBe(true);
    expect(ALWAYS_IGNORE_FILES.has('pnpm-lock.yaml')).toBe(true);
  });

  it('ignores OS metadata files', () => {
    expect(ALWAYS_IGNORE_FILES.has('.DS_Store')).toBe(true);
    expect(ALWAYS_IGNORE_FILES.has('Thumbs.db')).toBe(true);
  });
});

// ─── ALWAYS_IGNORE_EXTENSIONS ─────────────────────────────────────────────────

describe('ALWAYS_IGNORE_EXTENSIONS', () => {
  it('ignores image formats', () => {
    expect(ALWAYS_IGNORE_EXTENSIONS.has('png')).toBe(true);
    expect(ALWAYS_IGNORE_EXTENSIONS.has('jpg')).toBe(true);
    expect(ALWAYS_IGNORE_EXTENSIONS.has('svg')).toBe(true);
  });

  it('ignores binary/compiled formats', () => {
    expect(ALWAYS_IGNORE_EXTENSIONS.has('exe')).toBe(true);
    expect(ALWAYS_IGNORE_EXTENSIONS.has('wasm')).toBe(true);
    expect(ALWAYS_IGNORE_EXTENSIONS.has('dll')).toBe(true);
  });

  it('ignores source maps', () => {
    expect(ALWAYS_IGNORE_EXTENSIONS.has('map')).toBe(true);
  });
});

// ─── walkDirectory — symlink hardening ───────────────────────────────────────

// Symlink creation on Windows requires elevated privileges (SeCreateSymbolicLinkPrivilege).
// These tests are Unix-only.
describe('walkDirectory — symlink hardening', () => {
  it.skipIf(process.platform === 'win32')(
    'does not include files from a symlink target outside the project root',
    async () => {
      // Build: /tmp/outside-<id>/secret.ts  (outside the project)
      //        /tmp/project-<id>/src/hello.ts
      //        /tmp/project-<id>/link  →  /tmp/outside-<id>/  (escaping symlink)
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbm-outside-'));
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbm-project-'));

      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp dir created above
        await fs.writeFile(path.join(outsideDir, 'secret.ts'), 'export const x = 1', 'utf-8');
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp dir created above
        await fs.mkdir(path.join(projectDir, 'src'));
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp dir created above
        await fs.writeFile(path.join(projectDir, 'src', 'hello.ts'), 'export const y = 2', 'utf-8');
        // Symlink inside project pointing to outside dir
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp dir created above
        await fs.symlink(outsideDir, path.join(projectDir, 'link'));

        const ctx: WalkContext = {
          projectRoot: projectDir,
          ig: ignore(),
          maxSize: 512 * 1024,
          maxFiles: 10000,
          files: [],
        };
        await walkDirectory(projectDir, ctx);

        const paths = ctx.files.map((f) => f.absolutePath);
        // Must find the in-project file
        expect(paths.some((p) => p.includes('hello.ts'))).toBe(true);
        // Must NOT find the outside file
        expect(paths.some((p) => p.includes('secret.ts'))).toBe(false);
        // All returned paths must start with the project root
        for (const p of paths) {
          expect(p.startsWith(projectDir)).toBe(true);
        }
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
        await fs.rm(projectDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'walks a symlink whose target is inside the project root',
    async () => {
      // Build: /tmp/project-<id>/real/inner.ts
      //        /tmp/project-<id>/link  →  /tmp/project-<id>/real  (internal symlink)
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbm-intern-'));

      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp dir created above
        await fs.mkdir(path.join(projectDir, 'real'));
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp dir created above
        await fs.writeFile(
          path.join(projectDir, 'real', 'inner.ts'),
          'export const z = 3',
          'utf-8',
        );
        // Symlink pointing to a dir inside the same project root
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp dir created above
        await fs.symlink(path.join(projectDir, 'real'), path.join(projectDir, 'link'));

        const ctx: WalkContext = {
          projectRoot: projectDir,
          ig: ignore(),
          maxSize: 512 * 1024,
          maxFiles: 10000,
          files: [],
        };
        await walkDirectory(projectDir, ctx);

        const paths = ctx.files.map((f) => f.absolutePath);
        // inner.ts should appear at least once (via real/ or link/)
        expect(paths.some((p) => p.includes('inner.ts'))).toBe(true);
        // All returned paths still within project root
        for (const p of paths) {
          expect(p.startsWith(projectDir)).toBe(true);
        }
      } finally {
        await fs.rm(projectDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')('silently skips a dangling symlink', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbm-dangling-'));

    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp dir created above
      await fs.writeFile(path.join(projectDir, 'real.ts'), 'export const a = 1', 'utf-8');
      // Symlink to a path that does not exist
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp dir created above
      await fs.symlink(path.join(projectDir, 'nonexistent'), path.join(projectDir, 'dangling'));

      const ctx: WalkContext = {
        projectRoot: projectDir,
        ig: ignore(),
        maxSize: 512 * 1024,
        maxFiles: 10000,
        files: [],
      };
      // Must not throw
      await expect(walkDirectory(projectDir, ctx)).resolves.toBeUndefined();

      const paths = ctx.files.map((f) => f.absolutePath);
      expect(paths.some((p) => p.includes('real.ts'))).toBe(true);
      // dangling symlink should not appear in results
      expect(paths.some((p) => path.basename(p) === 'dangling')).toBe(false);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});

#!/usr/bin/env node
/**
 * fix-extensions.mjs — Post-build script that adds .js extensions to all
 * extensionless relative imports in the dist/ directory.
 *
 * Background: TypeScript with "module": "ESNext" emits import statements
 * exactly as written in source (no extension added). Node.js ESM requires
 * explicit .js extensions for relative imports. This script bridges the gap
 * so `node dist/index.js` works correctly as a standalone MCP server.
 *
 * Run via: node scripts/fix-extensions.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

/**
 * Rewrite a single JS file: add .js to any relative import/export that lacks
 * a file extension and isn't already using one.
 */
function fixFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  // Match: from './foo' or from "./foo" (no extension, starts with ./ or ../)
  // Also matches: export ... from './foo'
  // Does NOT match: from './foo.js', from 'some-package'
  const fixed = src.replace(
    /((?:import|export)[^'"]*from\s+['"])(\.[^'"]+)(['"])/g,
    (_match, prefix, specifier, suffix) => {
      // Skip if already has an extension (has a dot after the last slash)
      const lastSegment = specifier.split('/').at(-1) ?? '';
      if (lastSegment.includes('.')) return `${prefix}${specifier}${suffix}`;
      return `${prefix}${specifier}.js${suffix}`;
    },
  );
  if (fixed !== src) {
    fs.writeFileSync(filePath, fixed, 'utf8');
  }
}

/**
 * Walk the dist/ directory and fix all .js files.
 */
function walkAndFix(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndFix(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      fixFile(full);
    }
  }
}

walkAndFix(DIST_DIR);
console.error(`[fix-extensions] processed dist/ directory`);

/**
 * ts-morph-spike.ts — THROWAWAY feasibility spike (no graph writes, no DB).
 *
 * Measures:
 *   1. Cold-start: wall-clock ms for Project construction + first type-checker query.
 *   2. Resolution coverage over queryEngine.ts, lib.ts, and indexingPipeline.ts:
 *      resolved / total call+new expressions = N%.
 *   3. Barrel-win: at least one concrete case where ts-morph traces through a
 *      barrel/re-export to the TRUE original declaration.
 *   4. Bundled TypeScript version sanity check.
 *
 * Run with: npx tsx scripts/ts-morph-spike.ts
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { Project, ts } from 'ts-morph';
import type { CallExpression, NewExpression, Node, SourceFile } from 'ts-morph';

// ── Locate tsconfig relative to this script ────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const TSCONFIG_PATH = path.join(REPO_ROOT, 'tsconfig.json');

console.log('='.repeat(70));
console.log('ts-morph feasibility spike');
console.log('='.repeat(70));
console.log(`tsconfig: ${TSCONFIG_PATH}`);

// ── [4] TypeScript version sanity ─────────────────────────────────────────

console.log(`\n[4] Bundled ts.version = ${ts.version}`);

// ── [1] Cold-start measurement ─────────────────────────────────────────────

console.log('\n[1] Cold-start: constructing Project and running first type-checker query...');
const coldStart = performance.now();

const project = new Project({
  tsConfigFilePath: TSCONFIG_PATH,
  // skipAddingFilesFromTsConfig: false  — default, eager-load all files
  skipFileDependencyResolution: false,
});

// Force the type checker to actually warm up by doing a real query on any file.
const allFiles = project.getSourceFiles();
const warmupFile = allFiles[0];
if (warmupFile) {
  // getDescendantsOfKind forces the type-checker to parse and bind the file.
  warmupFile.getDescendantsOfKind(ts.SyntaxKind.CallExpression);
}

const coldEnd = performance.now();
const coldMs = Math.round(coldEnd - coldStart);

console.log(`Cold-start: ${coldMs} ms   (bar: < ~15 000 ms)`);
console.log(`Files loaded by tsconfig: ${allFiles.length}`);

// ── Resolution helper ──────────────────────────────────────────────────────

interface ResolutionResult {
  resolvedFile: string | null;
  resolvedLine: number | null;
  resolvedName: string | null;
}

function tryResolveCallExpr(
  expr: CallExpression | NewExpression,
  checker: ReturnType<typeof project.getTypeChecker>,
): ResolutionResult {
  try {
    // Strategy A: getResolvedSignature → getDeclaration
    const sig = checker.getResolvedSignature(expr);
    const decl = sig?.getDeclaration();
    if (decl) {
      const sf = decl.getSourceFile();
      const filePath = sf.getFilePath();
      const line = decl.getStartLineNumber();
      const sym = decl.getSymbol();
      const name = sym?.getName() ?? null;
      return { resolvedFile: filePath, resolvedLine: line, resolvedName: name };
    }
  } catch {
    // Strategy A failed — fall through.
  }

  try {
    // Strategy B: callee identifier → symbol → aliased symbol → declarations
    const calleeExpr = expr.getExpression();
    // getDescendantsOfKind on the callee to find the leaf identifier
    const identifiers = calleeExpr.getDescendantsOfKind(ts.SyntaxKind.Identifier);
    const ident = identifiers[identifiers.length - 1] ?? calleeExpr;

    const rawSym = (ident as Node).getSymbol?.();
    if (!rawSym) return { resolvedFile: null, resolvedLine: null, resolvedName: null };

    // Unwrap barrel aliases
    const sym = rawSym.getAliasedSymbol() ?? rawSym;
    const decls = sym.getDeclarations();
    if (decls.length === 0) return { resolvedFile: null, resolvedLine: null, resolvedName: null };

    const decl = decls[0];
    const sf = decl.getSourceFile();
    return {
      resolvedFile: sf.getFilePath(),
      resolvedLine: decl.getStartLineNumber(),
      resolvedName: sym.getName(),
    };
  } catch {
    return { resolvedFile: null, resolvedLine: null, resolvedName: null };
  }
}

// ── Per-file analysis ──────────────────────────────────────────────────────

interface FileStats {
  filePath: string;
  total: number;
  resolved: number;
  pct: string;
}

function analyzeFile(sf: SourceFile): FileStats {
  const checker = project.getTypeChecker();
  const calls = sf.getDescendantsOfKind(ts.SyntaxKind.CallExpression) as CallExpression[];
  const news = sf.getDescendantsOfKind(ts.SyntaxKind.NewExpression) as NewExpression[];
  const all: Array<CallExpression | NewExpression> = [...calls, ...news];

  let resolved = 0;
  for (const expr of all) {
    const result = tryResolveCallExpr(expr, checker);
    if (result.resolvedFile !== null) resolved++;
  }

  const total = all.length;
  const pct = total === 0 ? 'N/A' : `${Math.round((resolved / total) * 100)}%`;
  return { filePath: sf.getFilePath(), total, resolved, pct };
}

// ── [2] Coverage over representative files ─────────────────────────────────

const TARGET_SUFFIXES = ['src/queryEngine.ts', 'src/lib.ts', 'src/indexingPipeline.ts'];

console.log('\n[2] Resolution coverage per file:');

const fileStats: FileStats[] = [];
for (const suffix of TARGET_SUFFIXES) {
  // ts-morph returns forward-slash paths on all platforms (TypeScript compiler normalization).
  // Do NOT use path.sep — always match with forward slashes.
  const sf = allFiles.find((f) => f.getFilePath().endsWith(suffix));
  if (!sf) {
    console.log(`  SKIP (not found): ${suffix}`);
    continue;
  }
  const stats = analyzeFile(sf);
  fileStats.push(stats);
  console.log(
    `  ${path.relative(REPO_ROOT, stats.filePath).padEnd(40)} ` +
      `total=${stats.total.toString().padStart(4)}  resolved=${stats.resolved.toString().padStart(4)}  (${stats.pct})`,
  );
}

// Aggregate
const aggTotal = fileStats.reduce((s, f) => s + f.total, 0);
const aggResolved = fileStats.reduce((s, f) => s + f.resolved, 0);
const aggPct =
  aggTotal === 0 ? 'N/A' : `${Math.round((aggResolved / aggTotal) * 100)}%`;
console.log(
  `\n  AGGREGATE: resolved ${aggResolved} / ${aggTotal} = ${aggPct}   (bar: ≥ 80%)`,
);

// ── [3] Barrel-win demonstration ───────────────────────────────────────────

console.log('\n[3] Barrel-win: tracing calls-through-barrel to true declaration...');

// queryEngine.ts imports many things from './queryEngineSupport' (which itself
// doesn't re-export from sub-files, but IS the kind of "aggregating module" the
// current name-matching pass treats as opaque).  lib.ts is the pure barrel
// (re-exports from 10 different files).
//
// We scan ALL call expressions in queryEngine.ts and look for ones whose
// callee symbol resolves to a file OTHER than queryEngineSupport.ts itself
// (i.e., the checker already unaliased through any barrel chain).

const checker = project.getTypeChecker();
let barrelWinPrinted = 0;

for (const suffix of ['src/queryEngine.ts', 'src/lib.ts']) {
  // ts-morph returns forward-slash paths — do not use path.sep.
  const sf = allFiles.find((f) => f.getFilePath().endsWith(suffix));
  if (!sf) continue;

  const calls = sf.getDescendantsOfKind(ts.SyntaxKind.CallExpression) as CallExpression[];
  for (const call of calls) {
    if (barrelWinPrinted >= 3) break;

    const callText = call.getText().slice(0, 60);
    const callLine = call.getStartLineNumber();
    // Use forward-slash relative paths (ts-morph normalization).
    const repoRootFwd = REPO_ROOT.replace(/\\/g, '/');
    const callFile = sf.getFilePath().replace(repoRootFwd + '/', '');

    const result = tryResolveCallExpr(call, checker);
    if (!result.resolvedFile) continue;

    const resolvedRel = result.resolvedFile.replace(repoRootFwd + '/', '');

    // A barrel-win: resolved file differs from calling file (cross-file resolution).
    if (resolvedRel === callFile) continue;
    if (resolvedRel.includes('node_modules')) continue;

    console.log(`  BARREL-WIN #${barrelWinPrinted + 1}:`);
    console.log(`    call text   : ${callText}`);
    console.log(`    call site   : ${callFile}:${callLine}`);
    console.log(`    resolved to : ${resolvedRel}:${result.resolvedLine ?? '?'} [${result.resolvedName ?? '?'}]`);
    barrelWinPrinted++;
  }
  if (barrelWinPrinted >= 3) break;
}

if (barrelWinPrinted === 0) {
  // Widen search — try any file
  console.log('  (no barrel-wins found in primary targets; scanning all files...)');
  const repoRootFwd = REPO_ROOT.replace(/\\/g, '/');
  outer: for (const sf of allFiles) {
    const sfPath = sf.getFilePath();
    if (sfPath.includes('node_modules')) continue;
    if (sfPath.includes('.test.') || sfPath.includes('.spec.')) continue;

    const calls = sf.getDescendantsOfKind(ts.SyntaxKind.CallExpression) as CallExpression[];
    for (const call of calls) {
      const result = tryResolveCallExpr(call, checker);
      if (!result.resolvedFile) continue;
      const callFile = sfPath.replace(repoRootFwd + '/', '');
      const resolvedRel = result.resolvedFile.replace(repoRootFwd + '/', '');
      if (resolvedRel === callFile) continue;
      if (resolvedRel.includes('node_modules')) continue;

      const callText = call.getText().slice(0, 60);
      const callLine = call.getStartLineNumber();
      console.log(`  BARREL-WIN (widened):`);
      console.log(`    call text   : ${callText}`);
      console.log(`    call site   : ${callFile}:${callLine}`);
      console.log(`    resolved to : ${resolvedRel}:${result.resolvedLine ?? '?'} [${result.resolvedName ?? '?'}]`);
      barrelWinPrinted++;
      if (barrelWinPrinted >= 3) break outer;
    }
  }
}

if (barrelWinPrinted === 0) {
  console.log('  WARNING: no cross-file barrel-wins found.');
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log(`  ts.version   : ${ts.version}`);
console.log(`  cold-start   : ${coldMs} ms   (bar: < 15 000 ms)  → ${coldMs < 15000 ? 'PASS' : 'FAIL'}`);
const coverageNum = aggTotal > 0 ? Math.round((aggResolved / aggTotal) * 100) : -1;
console.log(`  coverage     : ${aggResolved}/${aggTotal} = ${aggPct}   (bar: ≥ 80%)  → ${coverageNum >= 80 ? 'PASS' : 'FAIL'}`);
console.log(`  barrel-wins  : ${barrelWinPrinted} shown`);
console.log('='.repeat(70));

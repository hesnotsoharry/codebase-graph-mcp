/**
 * testDetectPass.ts — Test file detection pass.
 *
 * Identifies test files by common naming conventions (*.test.*, *.spec.*,
 * *_test.*, *_spec.*) and creates TESTS edges between test functions and
 * the production functions they exercise. Uses two complementary heuristics:
 *
 *   1. Name-based: test function name contains the subject function name.
 *   2. Import-based: the test file imports specific functions from the
 *      subject module.
 *
 * Performance: The Function+Method symbol index is cached per-project at
 * module level (FIFO, capped at FUNCTION_INDEX_CACHE_MAX projects). The
 * cache is invalidated when a changed file's QN prefix intersects the
 * cached functionsByName keys, or unconditionally on a full reindex
 * (changedFiles === undefined). Observable via [trace:testDetectPass.cache].
 */
import { consoleErrorLogger } from '../loggerInterface.js';
// ─── Test file detection pattern ─────────────────────────────────────────────
const TEST_FILE_PATTERN = /\.(test|spec|_test|_spec)\.[^.]+$/;
const FUNCTION_INDEX_CACHE_MAX = 10;
const _functionIndexCache = new Map();
function evictOldestIfFull() {
    if (_functionIndexCache.size >= FUNCTION_INDEX_CACHE_MAX) {
        const oldestKey = _functionIndexCache.keys().next().value;
        if (oldestKey !== undefined)
            _functionIndexCache.delete(oldestKey);
    }
}
// ─── Edge builders ────────────────────────────────────────────────────────────
function buildNameHeuristicEdges(projectName, testFnQn, testNameLower, subjectFunctions) {
    return subjectFunctions
        .filter((fn) => testNameLower.includes(fn.name.toLowerCase()))
        .map((fn) => ({
        project: projectName,
        source_id: testFnQn,
        target_id: fn.id,
        type: 'TESTS',
        props: {},
    }));
}
function buildImportHeuristicEdges(ctx, testFnQn) {
    const { projectName, subjectPath, subjectQn, functionsByName, imports } = ctx;
    const edges = [];
    const subjectPathNoExt = subjectPath.replace(/\.[^.]+$/, '');
    for (const imp of imports) {
        if (!imp.source.includes(subjectPathNoExt))
            continue;
        for (const spec of imp.specifiers) {
            const candidates = functionsByName.get(spec.originalName ?? spec.name);
            if (!candidates)
                continue;
            const target = candidates.find((c) => c.startsWith(subjectQn)) ?? candidates[0];
            edges.push({
                project: projectName,
                source_id: testFnQn,
                target_id: target,
                type: 'TESTS',
                props: {},
            });
        }
    }
    return edges;
}
function buildTestFunctionEdges(ctx, def) {
    const testFnQn = `${ctx.fileQn}.${def.name}`;
    const testNameLower = def.name.toLowerCase();
    return [
        ...buildNameHeuristicEdges(ctx.projectName, testFnQn, testNameLower, ctx.subjectFunctions),
        ...buildImportHeuristicEdges(ctx, testFnQn),
    ];
}
// ─── Build function-by-name index (production functions only) ─────────────────
function buildFunctionsByName(allFunctions) {
    const functionsByName = new Map();
    for (const fn of allFunctions) {
        if (fn.file_path && TEST_FILE_PATTERN.test(fn.file_path))
            continue;
        const names = functionsByName.get(fn.name) ?? [];
        names.push(fn.id);
        functionsByName.set(fn.name, names);
    }
    return functionsByName;
}
function qnIntersectsPrefix(functionsByName, fileQnPrefix) {
    const prefixDot = `${fileQnPrefix}.`;
    for (const qns of functionsByName.values()) {
        for (const qn of qns) {
            if (qn === fileQnPrefix || qn.startsWith(prefixDot))
                return true;
        }
    }
    return false;
}
function computeInvalidationReason(entry, changedFiles, projectName) {
    if (!entry)
        return 'cold';
    // Full reindex: changedFiles === undefined means caller wants unconditional rebuild.
    if (changedFiles === undefined)
        return 'full';
    // Empty changeset: existing entry is valid — cache hit.
    if (changedFiles.size === 0)
        return null;
    // Per-file QN-prefix intersection check.
    for (const relativePath of changedFiles) {
        const fileQnPrefix = `${projectName}.${relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
        if (qnIntersectsPrefix(entry.functionsByName, fileQnPrefix))
            return 'invalidated';
    }
    return null;
}
// ─── Process a single test file ───────────────────────────────────────────────
function processTestFile(file, allFunctions, projectName, functionsByName) {
    if (!file.parsed || !TEST_FILE_PATTERN.test(file.relativePath))
        return [];
    const fileQn = `${projectName}.${file.relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
    const subjectPath = file.relativePath
        .replace(/\.(test|spec)\.([^.]+)$/, '.$2')
        .replace(/(_test|_spec)\.([^.]+)$/, '.$2');
    const subjectQn = `${projectName}.${subjectPath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
    const ctx = {
        projectName,
        fileQn,
        subjectPath,
        subjectQn,
        subjectFunctions: allFunctions.filter((f) => f.id.startsWith(subjectQn + '.')),
        functionsByName,
        imports: file.parsed.imports,
    };
    return file.parsed.definitions
        .filter((def) => def.kind === 'Function' || def.kind === 'Test')
        .flatMap((def) => buildTestFunctionEdges(ctx, def));
}
// ─── Pass implementation ─────────────────────────────────────────────────────
export function testDetectPass(db, projectName, indexedFiles, changedFiles, logger = consoleErrorLogger) {
    const startMs = Date.now();
    let cacheStatus = 'hit';
    let entry = _functionIndexCache.get(projectName);
    const reason = computeInvalidationReason(entry, changedFiles, projectName);
    if (reason !== null) {
        cacheStatus =
            reason === 'cold' ? 'miss-cold' :
                reason === 'full' ? 'miss-full' :
                    'miss-invalidated';
        evictOldestIfFull();
        const allFunctions = db
            .getNodesByLabel(projectName, 'Function')
            .concat(db.getNodesByLabel(projectName, 'Method'));
        const functionsByName = buildFunctionsByName(allFunctions);
        entry = { allFunctions, functionsByName };
        _functionIndexCache.set(projectName, entry);
    }
    // entry is guaranteed non-null at this point: either it existed (null reason)
    // or we just populated it above (non-null reason).
    const { allFunctions, functionsByName } = entry;
    const durationMs = Date.now() - startMs;
    logger.info('[trace:testDetectPass.cache]', { projectName, status: cacheStatus, durationMs });
    const allEdges = indexedFiles.flatMap((file) => processTestFile(file, allFunctions, projectName, functionsByName));
    const seen = new Set();
    const unique = allEdges.filter((e) => {
        const key = `${e.source_id}|${e.target_id}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
    if (unique.length > 0)
        db.insertEdges(unique);
}
// ─── Test-only export for cache inspection ────────────────────────────────────
export { _functionIndexCache };
//# sourceMappingURL=testDetectPass.js.map
/**
 * indexingPipelineCallResolution.ts — Call resolution pass helpers extracted
 * from indexingPipeline.ts to stay under the 300-line limit.
 *
 * Resolves function call sites to their definitions by cross-referencing
 * the file's import map and the global symbols-by-name index.
 */
// ─── Import specifier resolution ──────────────────────────────────────────────
function resolveImportSpecifier(_specName, candidates, impSource) {
    if (candidates.length === 1)
        return candidates[0];
    if (candidates.length > 1) {
        const fromFile = impSource.replace(/^\.\//, '').replace(/\.[^.]+$/, '');
        return candidates.find((c) => c.includes(fromFile.replace(/\//g, '.'))) ?? null;
    }
    return null;
}
function resolveFileImports(file, symbolsByName) {
    const importedNames = new Map();
    if (!file.parsed)
        return importedNames;
    for (const imp of file.parsed.imports) {
        if (imp.isTypeOnly)
            continue;
        for (const spec of imp.specifiers) {
            const candidates = symbolsByName.get(spec.originalName ?? spec.name) ?? [];
            const resolved = resolveImportSpecifier(spec.name, candidates, imp.source);
            if (resolved)
                importedNames.set(spec.name, resolved);
        }
    }
    return importedNames;
}
function buildFileImportMap(indexedFiles, projectName, symbolsByName) {
    const fileImportMap = new Map();
    for (const file of indexedFiles) {
        if (!file.parsed)
            continue;
        const fileQn = `${projectName}.${file.relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
        fileImportMap.set(fileQn, resolveFileImports(file, symbolsByName));
    }
    return fileImportMap;
}
// ─── Confidence constants (Phase A calibration) ───────────────────────────────
// Each value corresponds to a resolution path ordered by reliability.
// See roadmap/wave-80-edge-confidence/phase-a-calibration.md for rationale.
const CONFIDENCE_IMPORT_RESOLVED = 0.95;
const CONFIDENCE_SAME_FILE = 0.85;
const CONFIDENCE_NAME_UNIQUE = 0.80;
const CONFIDENCE_NEW_EXPRESSION_CLASS = 0.65;
function resolveCallee(calleeName, fileCtx, ctx, isNewExpression = false) {
    if (fileCtx.importedNames.has(calleeName)) {
        return {
            calleeQn: fileCtx.importedNames.get(calleeName),
            confidence: CONFIDENCE_IMPORT_RESOLVED,
            resolutionMethod: 'import_resolved',
        };
    }
    const sameFileDef = fileCtx.fileDefs.find((d) => d.name === calleeName);
    if (sameFileDef) {
        return {
            calleeQn: `${fileCtx.fileQn}.${sameFileDef.name}`,
            confidence: CONFIDENCE_SAME_FILE,
            resolutionMethod: 'same_file',
        };
    }
    const candidates = ctx.symbolsByName.get(calleeName) ?? [];
    if (candidates.length === 0)
        return null;
    if (candidates.length === 1) {
        return { calleeQn: candidates[0], confidence: CONFIDENCE_NAME_UNIQUE, resolutionMethod: 'name_unique' };
    }
    // Multiple candidates: for `new X()` prefer the Class node (qualified name ends with .X
    // and the node was registered via the Class label). Caller passes isNewExpression.
    if (isNewExpression) {
        const classCandidate = candidates.find((id) => ctx.classIds?.has(id));
        if (classCandidate) {
            return {
                calleeQn: classCandidate,
                confidence: CONFIDENCE_NEW_EXPRESSION_CLASS,
                resolutionMethod: 'new_expression',
            };
        }
    }
    return null;
}
function resolveCallEdges(indexedFiles, ctx, edges) {
    for (const file of indexedFiles) {
        if (!file.parsed)
            continue;
        const fileQn = `${ctx.projectName}.${file.relativePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
        const importedNames = ctx.fileImportMap.get(fileQn) ?? new Map();
        const fileDefs = file.parsed.definitions.filter((d) => d.kind === 'Function' || d.kind === 'Method');
        const fileCtx = { importedNames, fileDefs, fileQn };
        for (const call of file.parsed.calls) {
            const enclosingDef = fileDefs.find((d) => call.startLine >= d.startLine && call.startLine <= d.endLine);
            if (!enclosingDef)
                continue;
            const callerQn = `${fileQn}.${enclosingDef.name}`;
            const resolved = resolveCallee(call.calleeName, fileCtx, ctx, call.isNewExpression);
            if (resolved && resolved.calleeQn !== callerQn) {
                edges.push({
                    project: ctx.projectName,
                    source_id: callerQn,
                    target_id: resolved.calleeQn,
                    type: call.isAsync ? 'ASYNC_CALLS' : 'CALLS',
                    props: { resolution_method: resolved.resolutionMethod },
                    confidence: resolved.confidence,
                });
            }
        }
    }
}
// ─── Chunk helper ────────────────────────────────────────────────────────────
function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size)
        chunks.push(arr.slice(i, i + size));
    return chunks;
}
// ─── Public: Call Resolution Pass ────────────────────────────────────────────
function buildSymbolsByName(db, projectName) {
    const symbolsByName = new Map();
    const allDefinitions = db
        .getNodesByLabel(projectName, 'Function')
        .concat(db.getNodesByLabel(projectName, 'Method'))
        .concat(db.getNodesByLabel(projectName, 'Class'));
    for (const node of allDefinitions) {
        const names = symbolsByName.get(node.name) ?? [];
        names.push(node.id);
        symbolsByName.set(node.name, names);
    }
    return symbolsByName;
}
function deduplicateEdges(edges) {
    const seen = new Set();
    return edges.filter((e) => {
        const key = `${e.source_id}|${e.target_id}|${e.type}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function resolveChunkEdges(files, callCtx) {
    const edges = [];
    resolveCallEdges(files, callCtx, edges);
    return deduplicateEdges(edges);
}
export function callResolutionPass(db, projectName, indexedFiles, options) {
    const symbolsByName = buildSymbolsByName(db, projectName);
    const classIds = new Set(db.getNodesByLabel(projectName, 'Class').map((n) => n.id));
    const fileImportMap = buildFileImportMap(indexedFiles, projectName, symbolsByName);
    const callCtx = { projectName, symbolsByName, fileImportMap, classIds };
    // Safety net: build a Set of all valid node IDs from symbolsByName.
    // Filters out edges whose source or target was dropped by a failed definition chunk.
    const validNodeIds = new Set([...symbolsByName.values()].flat());
    const filterEdges = (edges) => edges.filter((e) => validNodeIds.has(e.source_id) && validNodeIds.has(e.target_id));
    const size = options?.chunkSize;
    if (!size) {
        db.insertEdges(filterEdges(resolveChunkEdges(indexedFiles, callCtx)));
        return;
    }
    for (const chunk of chunkArray(indexedFiles, size)) {
        db.transaction(() => db.insertEdges(filterEdges(resolveChunkEdges(chunk, callCtx))));
    }
}
//# sourceMappingURL=indexingPipelineCallResolution.js.map
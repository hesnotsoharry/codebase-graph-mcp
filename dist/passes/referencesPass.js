/**
 * referencesPass.ts — Pass 7: first-class REFERENCES edges for blast-radius completeness.
 *
 * Captures symbol references that CALLS and TYPEOF_REFERENCES miss:
 *   - Type-only references: a symbol used in a type annotation / param type /
 *     return type / extends-implements / generic arg — but never called.
 *   - Decorator uses: `@Component(...)` — the decorator name is a reference.
 *   - JSX element uses: `<MyComponent/>` — the tag name is a reference.
 *
 * Source model: FUNCTION-LEVEL (enclosing function/method/class QN), matching
 * the CALLS/ASYNC_CALLS model. This bounds edge-count growth — N type
 * references from one function to one type produce ONE edge (deduped).
 *
 * No tree-sitter base layer for REFERENCES (new edge type) → no supersession
 * delete needed. Idempotency is provided by INSERT OR REPLACE on the
 * UNIQUE(source_id, target_id, type) constraint.
 *
 * Blast-radius: `collectInboundNeighbours` in graphDatabaseSession.ts calls
 * `getInboundEdges()` with no edge-type filter, so REFERENCES edges are
 * followed automatically without any traversal changes.
 *
 * Incremental: Pass 7 runs after Pass 6 on the same Project instance. Pass 6
 * already called refreshFromFileSystem() for every file in indexedFiles, so
 * the AST is already fresh. No second refresh needed.
 *
 * Node kinds enumerated:
 *   TypeReference  — type annotations, param types, return types, extends/implements,
 *                    generic args (excludes `typeof` — that is TypeQuery/TYPEOF_REFERENCES)
 *   Decorator      — `@Name` and `@Name(...)` — the outer identifier is the reference
 *   JsxOpeningElement + JsxSelfClosingElement — JSX tag names
 *
 * Excluded from TypeReference processing:
 *   - TypeQuery nodes (`typeof X`) — handled by TYPEOF_REFERENCES in Pass 5.5/6
 *   - Built-in / lib types (string, number, Promise, etc.) — filtered by validNodeIds
 */
import { consoleErrorLogger as log } from '../loggerInterface.js';
import { ts } from 'ts-morph';
import { absoluteToRelative, buildFileQn, buildSymbolQn, getEnclosingFunctionName, } from './typescriptEnrichmentPass.js';
// ─── Constants ────────────────────────────────────────────────────────────────
const CONFIDENCE = 0.98;
const RESOLUTION_METHOD = 'compiler_api';
const TS_EXTENSIONS = new Set(['ts', 'tsx']);
// ─── validNodeIds for REFERENCES ─────────────────────────────────────────────
/**
 * REFERENCES can point to any indexed named entity: Function, Method, Class,
 * Interface, Type, Enum, Variable. Source must also be in this set.
 */
function buildReferencesValidNodeIds(db, projectName) {
    const all = db
        .getNodesByLabel(projectName, 'Function')
        .concat(db.getNodesByLabel(projectName, 'Method'))
        .concat(db.getNodesByLabel(projectName, 'Class'))
        .concat(db.getNodesByLabel(projectName, 'Interface'))
        .concat(db.getNodesByLabel(projectName, 'Type'))
        .concat(db.getNodesByLabel(projectName, 'Enum'))
        .concat(db.getNodesByLabel(projectName, 'Variable'));
    return new Set(all.map((n) => n.id));
}
// ─── Symbol → { filePath, symbolName } resolution ────────────────────────────
/**
 * Resolve a ts-morph Node that names a symbol (Identifier or similar) to
 * its canonical declaration, following aliases and barrel re-exports.
 * Returns null if unresolvable or if the symbol has no useful name.
 */
function resolveSymbolDeclaration(nameNode) {
    try {
        const sym = nameNode.getSymbol();
        if (!sym)
            return null;
        const aliased = sym.getAliasedSymbol() ?? sym;
        const decls = aliased.getDeclarations();
        if (decls.length === 0)
            return null;
        const symbolName = aliased.getName();
        if (!symbolName || symbolName === '__type' || symbolName === '__function')
            return null;
        const filePath = decls[0].getSourceFile().getFilePath().replace(/\\/g, '/');
        return { filePath, symbolName };
    }
    catch {
        return null;
    }
}
/**
 * Collect all type-references from TypeReference nodes (excluding TypeQuery
 * which is handled by the TYPEOF_REFERENCES machinery). These cover:
 *   param types, return types, property types, variable types, extends clauses,
 *   implements clauses, generic type arguments.
 */
function collectTypeReferences(sourceFile) {
    const refs = [];
    const nodes = sourceFile.getDescendantsOfKind(ts.SyntaxKind.TypeReference);
    for (const tr of nodes) {
        const enclosingName = getEnclosingFunctionName(tr);
        if (!enclosingName)
            continue;
        const nameNode = tr.getTypeName();
        // For qualified names (A.B), getTypeName() returns QualifiedName; getText()
        // gives "A.B". We resolve via the symbol to follow aliases correctly.
        const resolved = resolveSymbolDeclaration(nameNode);
        if (!resolved)
            continue;
        refs.push({ enclosingName, ...resolved });
    }
    return refs;
}
/**
 * Collect decorator references. A decorator `@Foo` or `@Foo(args)` references
 * the symbol `Foo`. The decorator expression is either an Identifier (plain
 * `@Foo`) or a CallExpression (`@Foo(...)`); in both cases we want the
 * outermost identifier naming the decorator.
 */
function collectDecoratorReferences(sourceFile) {
    const refs = [];
    const decorators = sourceFile.getDescendantsOfKind(ts.SyntaxKind.Decorator);
    for (const dec of decorators) {
        const enclosingName = getEnclosingFunctionName(dec);
        if (!enclosingName) {
            // Decorators on class declarations are at module scope with no enclosing
            // function. Use the class name as the source QN instead.
            // Walk up to find the decorated class/method to get an enclosing name.
            const decorated = dec.getParent();
            if (!decorated)
                continue;
            const decoratedKind = decorated.getKind();
            // Only ClassDeclaration reaches here: method decorators always yield an
            // enclosingName from getEnclosingFunctionName (the method name), so the
            // !enclosingName branch is unreachable for method decorators.
            if (decoratedKind !== ts.SyntaxKind.ClassDeclaration)
                continue;
            const sourceName = decorated.getName() ?? null;
            if (!sourceName)
                continue;
            const nameNode = getDecoratorNameNode(dec);
            if (!nameNode)
                continue;
            const resolved = resolveSymbolDeclaration(nameNode);
            if (!resolved)
                continue;
            refs.push({ enclosingName: sourceName, ...resolved });
            continue;
        }
        const nameNode = getDecoratorNameNode(dec);
        if (!nameNode)
            continue;
        const resolved = resolveSymbolDeclaration(nameNode);
        if (!resolved)
            continue;
        refs.push({ enclosingName, ...resolved });
    }
    return refs;
}
/**
 * Extract the identifier node that names a decorator (the outermost callable).
 * For `@Foo`        → the Identifier node for `Foo`
 * For `@Foo(...)`   → the Identifier node for `Foo` (callee of the call)
 * For `@a.b(...)`   → the PropertyAccessExpression's name node (`b`) — the
 *                     resolved declaration follows aliases to the real symbol.
 */
function getDecoratorNameNode(dec) {
    const expr = dec.getExpression();
    const kind = expr.getKind();
    if (kind === ts.SyntaxKind.Identifier) {
        return expr;
    }
    if (kind === ts.SyntaxKind.CallExpression) {
        const callee = expr.getExpression();
        if (callee.getKind() === ts.SyntaxKind.PropertyAccessExpression) {
            return callee.getNameNode();
        }
        return callee; // Identifier
    }
    return null;
}
/**
 * Collect JSX element tag references. Both `<MyComp/>` (self-closing) and
 * `<MyComp>...</MyComp>` (opening) reference the component symbol.
 * Skips intrinsic elements (lowercase tags like `div`, `span`) — those are
 * HTML built-ins, not indexed project symbols.
 */
function collectJsxReferences(sourceFile) {
    const refs = [];
    const selfClosing = sourceFile.getDescendantsOfKind(ts.SyntaxKind.JsxSelfClosingElement);
    const opening = sourceFile.getDescendantsOfKind(ts.SyntaxKind.JsxOpeningElement);
    const all = [...selfClosing, ...opening];
    for (const el of all) {
        const tagNode = el.getTagNameNode();
        const tagText = tagNode.getText();
        // Skip intrinsic (lowercase) HTML elements — they are not project symbols
        if (tagText.length > 0 && tagText[0] === tagText[0].toLowerCase() && tagText[0] !== '_') {
            continue;
        }
        const enclosingName = getEnclosingFunctionName(el);
        if (!enclosingName)
            continue;
        const resolved = resolveSymbolDeclaration(tagNode);
        if (!resolved)
            continue;
        refs.push({ enclosingName, ...resolved });
    }
    return refs;
}
// ─── Per-file edge building ───────────────────────────────────────────────────
/**
 * Collect all REFERENCES edges from one source file.
 * Deduplicates per (sourceQn, targetQn) — N references from one function to
 * one type produce exactly ONE edge.
 */
function resolveReferencesForFile(sourceFile, projectName, projectRoot, fileQn, validNodeIds) {
    const allRawRefs = [
        ...collectTypeReferences(sourceFile),
        ...collectDecoratorReferences(sourceFile),
        ...collectJsxReferences(sourceFile),
    ];
    // Dedup per (sourceQn, targetQn) using a Set key
    const seen = new Set();
    const edges = [];
    for (const raw of allRawRefs) {
        const sourceQn = buildSymbolQn(fileQn, raw.enclosingName);
        if (!validNodeIds.has(sourceQn))
            continue;
        const relPath = absoluteToRelative(raw.filePath, projectRoot);
        if (!relPath)
            continue; // target is outside the project
        const targetFileQn = buildFileQn(projectName, relPath);
        const targetQn = buildSymbolQn(targetFileQn, raw.symbolName);
        if (!validNodeIds.has(targetQn))
            continue;
        if (targetQn === sourceQn)
            continue; // skip self-references
        const key = `${sourceQn}|${targetQn}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        edges.push({
            project: projectName,
            source_id: sourceQn,
            target_id: targetQn,
            type: 'REFERENCES',
            props: { resolution_method: RESOLUTION_METHOD },
            confidence: CONFIDENCE,
        });
    }
    return edges;
}
/**
 * Pass 7 — first-class REFERENCES edges for blast-radius completeness.
 *
 * Enumerates type-only references, decorator uses, and JSX element uses that
 * CALLS and TYPEOF_REFERENCES miss. Source is function-level (enclosing
 * function/method/class QN). Deduped per (sourceQn, targetQn).
 *
 * No-op when tsMorphProject is null.
 * TS/TSX files only.
 */
export async function referencesPass(db, projectName, projectRoot, indexedFiles, options) {
    const { tsMorphProject } = options;
    if (!tsMorphProject)
        return;
    const tsFiles = indexedFiles.filter((f) => TS_EXTENSIONS.has(f.extension));
    if (tsFiles.length === 0)
        return;
    const validNodeIds = buildReferencesValidNodeIds(db, projectName);
    if (validNodeIds.size === 0)
        return;
    // Pass 6 already refreshed source files on this same Project instance.
    // We can navigate the AST directly without a second async refresh cycle.
    // However, files that were NOT in Pass 6's indexedFiles (shouldn't happen
    // in normal flow, but defensive) won't be refreshed. Accept that — the
    // incremental limitation is documented.
    for (const file of tsFiles) {
        const absPath = file.absolutePath.replace(/\\/g, '/');
        const sf = tsMorphProject.getSourceFile(absPath);
        if (!sf) {
            // File not yet in the Project — this shouldn't happen after Pass 6's
            // addSourceFileAtPath, but handle gracefully.
            log.warn('[trace:refsPass] source file not in project file=%s', file.relativePath);
            continue;
        }
        const fileQn = buildFileQn(projectName, file.relativePath);
        let edges;
        try {
            edges = resolveReferencesForFile(sf, projectName, projectRoot, fileQn, validNodeIds);
        }
        catch (err) {
            log.warn('[trace:refsPass] resolution failed file=%s: %s', file.relativePath, err instanceof Error ? err.message : String(err));
            continue;
        }
        if (edges.length === 0)
            continue;
        // No supersession needed — REFERENCES has no tree-sitter base layer.
        // INSERT OR REPLACE on UNIQUE(source_id, target_id, type) provides idempotency.
        try {
            db.insertEdges(edges);
        }
        catch (err) {
            log.warn('[trace:refsPass] insertEdges failed file=%s: %s', file.relativePath, err instanceof Error ? err.message : String(err));
        }
        log.info('[trace:refsPass] file=%s references=%d', file.relativePath, edges.length);
    }
}
//# sourceMappingURL=referencesPass.js.map
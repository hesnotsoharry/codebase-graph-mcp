/**
 * treeSitterParser.ts — WASM-based tree-sitter parser for multi-language
 * source code analysis. Extracts definitions, imports, calls, and routes.
 *
 * Grammars are loaded lazily on first use per extension and cached.
 * Concurrent loads of the same grammar are deduped via pendingLanguageLoads.
 * Grammar load failures mark the language as unsupported for the session
 * (no retry noise) and parseFile returns null for those files.
 */
import { createRequire } from 'node:module';
import path from 'path';
import { Language, Parser } from 'web-tree-sitter';
import { consoleErrorLogger as log } from './loggerInterface.js';
import { getLanguageConfig } from './treeSitterLanguageConfigs.js';
import { extractSingleDefinition } from './treeSitterParserDefs.js';
import { extractTestCaseDefinitions } from './treeSitterTestExtractor.js';
import { buildNodeTypeToLabelMap, collectDefaultImport, collectExportedIdentifiers, collectNamedImports, collectNamespaceImports, detectTypeOnlyImport, dispatchNonTsImport, extractArrowDeclarator, extractCallNodeInfo, extractHandlerName, extractHttpCallArgs, extractRouteCandidate, extractTopLevelNames, } from './treeSitterParserSupport.js';
// ESM-compatible require: bare `require` is undefined in ESM modules
// (`"type": "module"` in package.json). `createRequire(import.meta.url)`
// reconstructs a CommonJS-style require relative to THIS file's URL.
// Used to call `_require.resolve(...)` for locating WASM grammar files
// at runtime. Caveat: `_require.resolve` resolves relative to the
// entrypoint module URL, not the call-site file path — keep that in
// mind if this code moves between files.
const _require = createRequire(import.meta.url);
/** Maximum length for extracted signatures before truncation. */
const MAX_SIGNATURE_LENGTH = 200;
const TS_JS_LANGUAGES = new Set(['typescript', 'tsx', 'javascript', 'jsx']);
/**
 * Resolve candidate grammar WASM paths in preference order. Returns all paths
 * that exist; caller falls back if Language.load throws an ABI mismatch.
 * web-tree-sitter@0.26+ supports ABI 15 (required by @vscode/tree-sitter-wasm@0.3.1);
 * tree-sitter-wasms@0.1.13 remains as a fallback for unlisted languages.
 */
function resolveGrammarPaths(wasmFile) {
    const fs = _require('fs');
    const vscodeFile = wasmFile.replace('tree-sitter-c_sharp', 'tree-sitter-c-sharp');
    const tryResolve = (pkg, sub, file) => {
        try {
            const dir = path.dirname(_require.resolve(`${pkg}/package.json`));
            const p = path.join(dir, sub, file);
            return fs.existsSync(p) ? p : null;
        }
        catch {
            return null;
        }
    };
    return [
        tryResolve('@vscode/tree-sitter-wasm', 'wasm', vscodeFile),
        tryResolve('tree-sitter-wasms', 'out', wasmFile),
    ].filter((p) => p !== null);
}
export class TreeSitterParser {
    parser = null;
    languages = new Map();
    pendingLanguageLoads = new Map();
    unsupportedLanguages = new Set();
    initialized = false;
    // ─── Initialization ──────────────────────────────────────────────────────
    async init() {
        if (this.initialized)
            return;
        await Parser.init({
            locateFile(scriptName) {
                try {
                    // web-tree-sitter@0.26+ exports './web-tree-sitter.wasm' explicitly.
                    // Resolve via the wasm export key so it works in both CJS and ESM.
                    const wasmPath = _require.resolve('web-tree-sitter/web-tree-sitter.wasm');
                    return path.join(path.dirname(wasmPath), scriptName);
                }
                catch {
                    return scriptName;
                }
            },
        });
        this.parser = new Parser();
        this.initialized = true;
    }
    // ─── Language loading ─────────────────────────────────────────────────────
    async loadLanguage(config) {
        const cached = this.languages.get(config.id);
        if (cached)
            return cached;
        if (this.unsupportedLanguages.has(config.id))
            return null;
        // Dedup: if a load is already in-flight for this language, await it.
        const pending = this.pendingLanguageLoads.get(config.id);
        if (pending)
            return pending;
        const load = this.doLoadLanguage(config);
        this.pendingLanguageLoads.set(config.id, load);
        return load;
    }
    // ABI validated by setLanguage; Language.load alone accepts incompat ABIs.
    async tryLoadOne(id, p) {
        try {
            const lang = await Language.load(p);
            if (this.parser)
                this.parser.setLanguage(lang);
            return lang;
        }
        catch (err) {
            log.debug(`[treeSitterParser] load failed: ${id} @ ${p}:`, err);
            return null;
        }
    }
    async doLoadLanguage(config) {
        try {
            for (const p of resolveGrammarPaths(config.wasmFile)) {
                const lang = await this.tryLoadOne(config.id, p);
                if (lang) {
                    this.languages.set(config.id, lang);
                    return lang;
                }
            }
            this.unsupportedLanguages.add(config.id);
            return null;
        }
        finally {
            this.pendingLanguageLoads.delete(config.id);
        }
    }
    // ─── Main entry point ────────────────────────────────────────────────────
    async parseFile(relativePath, source) {
        if (!this.parser)
            throw new Error('TreeSitterParser not initialized — call init() first');
        const ext = path.extname(relativePath).slice(1);
        const config = getLanguageConfig(ext);
        if (!config)
            return null;
        const language = await this.loadLanguage(config);
        if (!language)
            return null;
        this.parser.setLanguage(language);
        const tree = this.parser.parse(source);
        if (!tree)
            return null;
        try {
            const definitions = this.extractDefinitions(tree.rootNode, config);
            const imports = this.extractImports(tree.rootNode, config);
            const calls = this.extractCalls(tree.rootNode, config);
            const routes = this.extractRoutes(tree.rootNode, config);
            const exportedNames = this.extractExportedNames(tree.rootNode, config);
            return {
                filePath: relativePath,
                language: config.id,
                lineCount: tree.rootNode.endPosition.row + 1,
                definitions,
                imports,
                calls,
                routes,
                exportedNames,
            };
        }
        finally {
            tree.delete();
        }
    }
    // ─── Definition extraction ───────────────────────────────────────────────
    extractDefinitions(rootNode, config) {
        const definitions = [];
        const nodeTypeToLabel = buildNodeTypeToLabelMap(config);
        this.walkTree(rootNode, (node) => {
            const label = nodeTypeToLabel.get(node.type);
            if (!label)
                return;
            const def = extractSingleDefinition(node, label, config);
            if (def)
                definitions.push(def);
        });
        if (TS_JS_LANGUAGES.has(config.id)) {
            this.extractArrowFunctions(rootNode, definitions);
            extractTestCaseDefinitions(rootNode, definitions);
        }
        return definitions;
    }
    extractArrowFunctions(rootNode, definitions) {
        const existingNames = new Set(definitions.map((d) => d.name));
        const isDecl = (t) => t === 'lexical_declaration' || t === 'variable_declaration';
        this.walkTree(rootNode, (node) => {
            const isExported = node.type === 'export_statement';
            const declaration = isExported
                ? node.namedChildren.find((c) => isDecl(c.type))
                : isDecl(node.type) && node.parent?.type === 'program'
                    ? node
                    : null;
            if (!declaration)
                return;
            const ctx = { existingNames, definitions, isExported };
            for (const d of declaration.namedChildren)
                extractArrowDeclarator(node, d, ctx);
        });
    }
    // ─── Import extraction ───────────────────────────────────────────────────
    extractImports(rootNode, config) {
        const imports = [];
        this.walkTree(rootNode, (node) => {
            if (!config.importNodes.includes(node.type))
                return;
            const result = this.dispatchImportExtractor(node, config);
            if (Array.isArray(result)) {
                for (const imp of result)
                    imports.push(imp);
            }
            else if (result) {
                imports.push(result);
            }
        });
        return imports;
    }
    dispatchImportExtractor(node, config) {
        if (TS_JS_LANGUAGES.has(config.id))
            return this.extractTsJsImport(node);
        return dispatchNonTsImport(node, config);
    }
    extractTsJsImport(node) {
        const sourceNode = node.childForFieldName('source');
        if (!sourceNode)
            return null;
        const importSource = sourceNode.text.replace(/['"]/g, '');
        const specifiers = [];
        const isTypeOnly = detectTypeOnlyImport(node);
        collectNamedImports(node, specifiers);
        collectDefaultImport(node, specifiers);
        collectNamespaceImports(node, specifiers);
        return {
            source: importSource,
            specifiers,
            isTypeOnly,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
        };
    }
    // ─── Call extraction ─────────────────────────────────────────────────────
    extractCalls(rootNode, config) {
        const calls = [];
        this.walkTree(rootNode, (node) => {
            if (!config.callNodes.includes(node.type))
                return;
            const info = extractCallNodeInfo(node, MAX_SIGNATURE_LENGTH);
            if (!info || !info.calleeName)
                return;
            const argsNode = node.childForFieldName('arguments') ??
                node.namedChildren.find((c) => c.type === 'arguments' || c.type === 'argument_list');
            const argCount = argsNode?.namedChildCount ?? 0;
            const { firstArgValue, optionsMethod } = extractHttpCallArgs(argsNode);
            calls.push({
                calleeName: info.calleeName,
                receiverName: info.receiverName,
                startLine: node.startPosition.row + 1,
                isAsync: info.isAsync,
                arguments: argCount,
                isNewExpression: node.type === 'new_expression',
                firstArgValue,
                optionsMethod,
            });
        });
        return calls;
    }
    // ─── Route extraction ────────────────────────────────────────────────────
    matchRoutePattern(node, candidate, config, routes) {
        const { objectText, methodText } = candidate;
        for (const pattern of config.routePatterns) {
            const receiverMatch = pattern.receiverNames.length === 0 || pattern.receiverNames.includes(objectText);
            if (!receiverMatch || !pattern.methodNames.includes(methodText))
                continue;
            const argsNode = node.childForFieldName('arguments') ??
                node.namedChildren.find((c) => c.type === 'arguments' || c.type === 'argument_list');
            if (!argsNode)
                continue;
            const pathArg = argsNode.namedChildren[pattern.pathArgIndex];
            if (!pathArg)
                continue;
            routes.push({
                method: methodText.toUpperCase(),
                path: pathArg.text.replace(/['"`]/g, ''),
                handlerName: extractHandlerName(argsNode, pattern.pathArgIndex),
                framework: pattern.framework,
                startLine: node.startPosition.row + 1,
            });
        }
    }
    extractRoutes(rootNode, config) {
        if (config.routePatterns.length === 0)
            return [];
        const routes = [];
        this.walkTree(rootNode, (node) => {
            if (!config.callNodes.includes(node.type))
                return;
            const candidate = extractRouteCandidate(node);
            if (!candidate.objectText || !candidate.methodText)
                return;
            this.matchRoutePattern(node, { objectText: candidate.objectText, methodText: candidate.methodText }, config, routes);
        });
        return routes;
    }
    // ─── Helper methods ──────────────────────────────────────────────────────
    walkTree(node, callback) {
        const stack = [node];
        while (stack.length > 0) {
            const current = stack.pop();
            callback(current);
            const childCount = current.childCount;
            for (let i = childCount - 1; i >= 0; i--) {
                const child = current.child(i);
                if (child)
                    stack.push(child);
            }
        }
    }
    extractExportedNames(rootNode, config) {
        if (!config.exportKeyword)
            return extractTopLevelNames(rootNode, config);
        const names = new Set();
        this.walkTree(rootNode, (node) => {
            if (node.type !== config.exportKeyword)
                return;
            collectExportedIdentifiers(node, this.walkTree.bind(this), names);
        });
        return Array.from(names);
    }
    // ─── Lifecycle ────────────────────────────────────────────────────────
    dispose() {
        if (this.parser) {
            this.parser.delete();
            this.parser = null;
        }
        this.languages.clear();
        this.pendingLanguageLoads.clear();
        this.unsupportedLanguages.clear();
        this.initialized = false;
    }
}
//# sourceMappingURL=treeSitterParser.js.map
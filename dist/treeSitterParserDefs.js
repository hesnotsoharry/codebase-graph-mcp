/**
 * treeSitterParserDefs.ts — Definition-building and AST utility helpers
 * extracted from treeSitterParserSupport.ts to keep that file under 300 lines.
 *
 * Contains: buildNodeTypeToLabelMap, hasModifier, findAncestorOfType,
 * extractReturnType, extractReturnTypeFromAnnotation, extractNodeSignature,
 * extractTopLevelNames, extractSingleDefinition, extractArrowDeclarator,
 * isNodeExported, isDefaultExport, collectExportedIdentifiers.
 */
import { collectDecorators, extractDefinitionNameNode, isArrowOrFunctionValue, resolveExportStatus, } from './treeSitterParserSupport.js';
// ─── Parser helper functions ──────────────────────────────────────────────────
const MAX_SIGNATURE_LENGTH = 200;
export function buildNodeTypeToLabelMap(config) {
    const map = new Map();
    for (const t of config.functionNodes)
        map.set(t, 'Function');
    for (const t of config.classNodes)
        map.set(t, 'Class');
    for (const t of config.interfaceNodes)
        map.set(t, 'Interface');
    for (const t of config.typeNodes)
        map.set(t, 'Type');
    for (const t of config.enumNodes)
        map.set(t, 'Enum');
    for (const t of config.methodNodes)
        map.set(t, 'Method');
    return map;
}
export function hasModifier(node, modifier) {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === modifier)
            return true;
    }
    const modifiers = node.childForFieldName('modifiers');
    if (modifiers) {
        for (let i = 0; i < modifiers.childCount; i++) {
            const child = modifiers.child(i);
            if (child && child.type === modifier)
                return true;
        }
    }
    return false;
}
export function findAncestorOfType(node, types) {
    if (types.length === 0)
        return null;
    let current = node.parent;
    while (current) {
        if (types.includes(current.type))
            return current;
        current = current.parent;
    }
    return null;
}
export function extractReturnType(node) {
    const returnTypeNode = node.childForFieldName('return_type');
    if (returnTypeNode)
        return returnTypeNode.text.replace(/^:\s*/, '').trim();
    const paramsNode = node.childForFieldName('parameters');
    if (paramsNode) {
        let sibling = paramsNode.nextNamedSibling;
        while (sibling) {
            if (sibling.type === 'type_annotation')
                return sibling.text.replace(/^:\s*/, '').trim();
            if (['statement_block', 'block', 'arrow_function', '=>'].includes(sibling.type))
                break;
            sibling = sibling.nextNamedSibling;
        }
    }
    return null;
}
export function extractReturnTypeFromAnnotation(declarator) {
    const typeAnnotation = declarator.childForFieldName('type') ??
        declarator.namedChildren.find((c) => c.type === 'type_annotation');
    if (!typeAnnotation)
        return null;
    return typeAnnotation.text.replace(/^:\s*/, '').trim();
}
export function extractNodeSignature(node) {
    const paramsNode = node.childForFieldName('parameters') ??
        node.namedChildren.find((c) => c.type === 'formal_parameters' || c.type === 'parameter_list');
    if (!paramsNode)
        return null;
    let sig = paramsNode.text;
    const returnType = extractReturnType(node);
    if (returnType)
        sig += `: ${returnType}`;
    sig = sig.replace(/\s+/g, ' ').trim();
    if (sig.length > MAX_SIGNATURE_LENGTH)
        sig = sig.slice(0, MAX_SIGNATURE_LENGTH - 3) + '...';
    return sig;
}
export function extractTopLevelNames(rootNode, config) {
    const names = [];
    const definitionTypes = new Set([
        ...config.functionNodes,
        ...config.classNodes,
        ...config.interfaceNodes,
        ...config.typeNodes,
        ...config.enumNodes,
    ]);
    for (const child of rootNode.namedChildren) {
        if (!definitionTypes.has(child.type))
            continue;
        const nameNode = child.childForFieldName('name');
        if (nameNode) {
            if (config.id === 'go' && !/^[A-Z]/.test(nameNode.text))
                continue;
            names.push(nameNode.text);
        }
    }
    return names;
}
// ─── Definition building helpers ──────────────────────────────────────────────
export function isNodeExported(node, config) {
    if (config.exportKeyword)
        return node.parent?.type === config.exportKeyword;
    return resolveExportStatus(node, config);
}
export function isDefaultExport(node) {
    const parent = node.parent;
    if (!parent || parent.type !== 'export_statement')
        return false;
    return parent.children.some((c) => c.type === 'default');
}
// Languages whose method node type overlaps with their function node type
// (Python function_definition, Rust function_item) reach extractSingleDefinition
// with label='Method' for ALL functions. Demote to Function when there is no
// enclosing class/impl block.
function resolveMethodContext(node, label, config) {
    if (label !== 'Method')
        return { effectiveLabel: label, receiver: null };
    const contextNode = findAncestorOfType(node, [...config.classNodes, 'impl_item']);
    if (!contextNode)
        return { effectiveLabel: 'Function', receiver: null };
    return { effectiveLabel: 'Method', receiver: contextNode.childForFieldName('name')?.text ?? null };
}
/** Extract the boolean modifier flags from a definition node. */
function extractNodeFlags(node, label) {
    return {
        isAsync: hasModifier(node, 'async'),
        isStatic: label === 'Method' && hasModifier(node, 'static'),
        isAbstract: node.type.includes('abstract') || hasModifier(node, 'abstract'),
    };
}
export function extractSingleDefinition(node, label, config) {
    const nameNode = extractDefinitionNameNode(node);
    if (!nameNode)
        return null;
    const name = nameNode.text;
    let signature = null;
    let returnType = null;
    if (label === 'Function' || label === 'Method') {
        signature = extractNodeSignature(node);
        returnType = extractReturnType(node);
    }
    const decorators = collectDecorators(node);
    const { isAsync, isStatic, isAbstract } = extractNodeFlags(node, label);
    const { effectiveLabel, receiver } = resolveMethodContext(node, label, config);
    const { implementsArr, extendsName } = effectiveLabel === 'Class'
        ? extractClassHeritage(node)
        : { implementsArr: undefined, extendsName: undefined };
    return {
        name,
        kind: effectiveLabel,
        signature,
        returnType,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        isExported: isNodeExported(node, config),
        isDefault: isDefaultExport(node),
        isAsync,
        isStatic,
        isAbstract,
        decorators,
        receiver,
        constants: [],
        implements: implementsArr,
        extendsClause: extendsName,
    };
}
// ─── Heritage extraction (Wave 21 Phase 1) ────────────────────────────────────
/** Extract the identifier text from a type_identifier or leading id of generic_type. */
function resolveIfaceName(ifaceChild) {
    if (ifaceChild.type === 'generic_type') {
        const inner = ifaceChild.namedChildren[0];
        return inner ? inner.text : ifaceChild.text;
    }
    return ifaceChild.text;
}
/**
 * Walk class_heritage children and collect extends + implements info.
 * `class_heritage` is a named child node type on class_declaration (NOT a field name).
 * Returns `{ implementsArr: undefined, extendsName: null }` when no heritage exists.
 */
function extractClassHeritage(node) {
    const heritage = node.namedChildren.find((c) => c.type === 'class_heritage');
    if (!heritage)
        return { implementsArr: undefined, extendsName: null };
    let implementsArr;
    let extendsName = null;
    for (const clauseChild of heritage.namedChildren) {
        if (clauseChild.type === 'extends_clause') {
            const target = clauseChild.namedChildren[0];
            if (target)
                extendsName = target.text;
        }
        else if (clauseChild.type === 'implements_clause') {
            implementsArr = clauseChild.namedChildren.map(resolveIfaceName);
        }
    }
    return { implementsArr, extendsName };
}
function buildArrowDef({ statementNode, declarator, valueNode }, name, isExported) {
    const isAsync = hasModifier(valueNode, 'async') || valueNode.text.startsWith('async');
    return {
        name,
        kind: 'Function',
        signature: extractNodeSignature(valueNode),
        returnType: extractReturnType(valueNode) ?? extractReturnTypeFromAnnotation(declarator),
        startLine: statementNode.startPosition.row + 1,
        endLine: statementNode.endPosition.row + 1,
        isExported,
        isDefault: isExported && isDefaultExport(statementNode),
        isAsync,
        isStatic: false,
        isAbstract: false,
        decorators: [],
        receiver: null,
        constants: [],
    };
}
export function extractArrowDeclarator(statementNode, declarator, ctx) {
    if (declarator.type !== 'variable_declarator')
        return;
    const nameNode = declarator.childForFieldName('name');
    const valueNode = declarator.childForFieldName('value');
    if (!nameNode || !valueNode || !isArrowOrFunctionValue(valueNode))
        return;
    // Skip destructured patterns (e.g. const { fn } = require(...)) — name is not a plain identifier
    if (nameNode.type !== 'identifier')
        return;
    const name = nameNode.text;
    if (ctx.existingNames.has(name))
        return;
    ctx.existingNames.add(name);
    const isExported = ctx.isExported ?? true;
    const nodes = { statementNode, declarator, valueNode };
    ctx.definitions.push(buildArrowDef(nodes, name, isExported));
}
/** Collect exported identifier names from an export_statement node via walkFn. */
export function collectExportedIdentifiers(exportNode, walkFn, names) {
    walkFn(exportNode, (child) => {
        if (child.type !== 'identifier' && child.type !== 'type_identifier')
            return;
        const parent = child.parent;
        if (parent &&
            parent.type !== 'import_clause' &&
            parent.type !== 'string' &&
            parent.type !== 'template_string') {
            names.add(child.text);
        }
    });
}
//# sourceMappingURL=treeSitterParserDefs.js.map
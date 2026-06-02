// ─── Node Labels ─────────────────────────────────────────────────────────────
/**
 * Exported set of all recognized edge type strings.
 * The acceptance test checks for an exported constant whose name matches
 * /edge.*type/i, /edgekind/i, or /EDGE_TYPES/ containing 'TYPEOF_REFERENCES'.
 *
 * Note: the edges table has no CHECK constraint on the type column (plain TEXT),
 * so no schema migration is needed to add a new edge type — see graphDatabaseSchema.ts.
 */
export const EDGE_TYPES = new Set([
    'CONTAINS_PACKAGE',
    'CONTAINS_FOLDER',
    'CONTAINS_FILE',
    'DEFINES',
    'DEFINES_METHOD',
    'IMPORTS',
    'CALLS',
    'HTTP_CALLS',
    'ASYNC_CALLS',
    'IMPLEMENTS',
    'HANDLES',
    'USAGE',
    'CONFIGURES',
    'WRITES',
    'MEMBER_OF',
    'TESTS',
    'USES_TYPE',
    'FILE_CHANGES_WITH',
    'EXPORTS',
    'EXTENDS',
    'TYPEOF_REFERENCES',
    'REFERENCES',
]);
// ─── Edge resolution provenance ──────────────────────────────────────────────
/**
 * How a graph edge was resolved. Stored as `props.resolution_method` on every
 * edge written by a resolution pass.
 *
 * Values:
 *   `compiler_api`    — reserved for Wave 2 (ts-morph / tsc type-checked resolution)
 *   `import_resolved` — callee was found by tracing an explicit import statement
 *   `same_file`       — callee is defined in the same file as the caller
 *   `name_unique`     — callee name is unique across the project (single candidate)
 *   `new_expression`  — `new X()` constructor — class node preferred among candidates
 *   `url_literal`     — HTTP_CALLS edge matched by static literal URL path + method
 *   `url_template`    — HTTP_CALLS edge matched by template-literal/param URL path + method
 *   `heuristic_name`  — HTTP_CALLS edge fell back to caller-name / route-path string heuristic
 *   `typeof_regex`    — TYPEOF_REFERENCES edge detected by regex scan of type-position `typeof`
 */
export const RESOLUTION_METHODS = [
    'compiler_api',
    'import_resolved',
    'same_file',
    'name_unique',
    'new_expression',
    'url_literal',
    'url_template',
    'heuristic_name',
    'typeof_regex',
];
//# sourceMappingURL=graphDatabaseTypes.js.map
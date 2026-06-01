/**
 * cypherEngineVarpath.ts — Variable-length path (varpath) SQL builder helpers
 * extracted from cypherEngineSupport.ts to keep that file under 300 lines.
 */
/** Build the start-node WHERE conditions for a varpath query. */
export function buildVarpathStartConditions(ctx, where, params, resolvers) {
    const { left, projectName } = ctx;
    const startConditions = ['n_start.project = ?'];
    params.push(projectName);
    if (left.label) {
        startConditions.push('n_start.label = ?');
        params.push(left.label);
    }
    for (const cond of where) {
        if (cond.kind === 'negated_existence')
            continue; // varpath doesn't handle NOT EXISTS patterns
        if (cond.alias === left.alias) {
            const expr = resolvers.resolveColumnExpression('n_start', cond.property);
            const sqlOp = resolvers.cypherOpToSql(cond.operator);
            startConditions.push(`${expr} ${sqlOp} ?`);
            params.push(cond.value);
        }
    }
    return startConditions;
}
/** Build the end-node WHERE conditions for a varpath query. */
export function buildVarpathEndConditions(right, where, params, resolvers) {
    const endConditions = [];
    if (right.label) {
        endConditions.push('n_end.label = ?');
        params.push(right.label);
    }
    for (const cond of where) {
        if (cond.kind === 'negated_existence')
            continue; // varpath doesn't handle NOT EXISTS patterns
        if (cond.alias === right.alias) {
            const expr = resolvers.resolveColumnExpression('n_end', cond.property);
            const sqlOp = resolvers.cypherOpToSql(cond.operator);
            endConditions.push(`${expr} ${sqlOp} ?`);
            params.push(cond.value);
        }
    }
    return endConditions;
}
/** Assemble the WITH RECURSIVE SQL for a variable-length path query. */
export function buildVarpathSqlTemplate(opts) {
    const { startConditions, nextNode, edgeJoin, endWhere, distinct, selectParts, orderBy } = opts;
    // Cycle detection: per-row visited set stored in `path` as a JSON array.
    // Anchor seeds with json_array(n_start.id). Recursive step appends the next
    // node via json_insert at '$[#]' (SQLite "next array index" — supported since
    // 3.31.0, well within better-sqlite3@12.8.0's bundled SQLite 3.53.x).
    // Membership guard uses NOT EXISTS over json_each, which performs structural
    // membership — immune to the prefix-collision hazard of the old LIKE pattern
    // (e.g. 'src.a' and 'src.auth' are distinct in a JSON array but not in a
    // LIKE '%src.a%' check). Start-node recovered via json_extract(path, '$[0]').
    // Wave 20 — cypherEngineVarpath.ts.
    return `
    WITH RECURSIVE reachable(current_id, depth, path) AS (
      SELECT n_start.id, 0, json_array(n_start.id)
      FROM nodes n_start
      WHERE ${startConditions.join(' AND ')}
      UNION ALL
      SELECT ${nextNode}, r.depth + 1, json_insert(r.path, '$[#]', ${nextNode})
      FROM reachable r
      JOIN edges e ON ${edgeJoin}
      WHERE r.depth < ?
        AND NOT EXISTS (SELECT 1 FROM json_each(r.path) WHERE value = ${nextNode})
    )
    SELECT ${distinct}${selectParts.join(', ')}
    FROM reachable r2
    JOIN nodes n_end ON n_end.id = r2.current_id
    JOIN nodes n_start ON n_start.id = json_extract(r2.path, '$[0]')
    WHERE r2.depth >= ? AND r2.depth <= ?
    ${endWhere}
    ${orderBy ? `ORDER BY ${orderBy}` : ''}
    LIMIT ?
  `.trim();
}
// ─── SELECT parts builder ─────────────────────────────────────────────────────
/** Build SELECT parts for a varpath query. */
export function buildVarpathSelectParts(returnFields, leftAlias, rightAlias, resolveColumnExpression) {
    const selectParts = [];
    for (const field of returnFields) {
        if (field.property === '*') {
            if (field.alias === leftAlias)
                selectParts.push(`n_start.id AS ${field.outputName}`);
            else if (field.alias === rightAlias)
                selectParts.push(`n_end.id AS ${field.outputName}`);
        }
        else {
            if (field.alias === leftAlias) {
                selectParts.push(`${resolveColumnExpression('n_start', field.property)} AS ${field.outputName}`);
            }
            else if (field.alias === rightAlias) {
                selectParts.push(`${resolveColumnExpression('n_end', field.property)} AS ${field.outputName}`);
            }
        }
    }
    return selectParts;
}
//# sourceMappingURL=cypherEngineVarpath.js.map
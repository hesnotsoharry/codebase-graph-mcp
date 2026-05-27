import { describe, expect, it } from 'vitest';

import {
  buildOrderBy,
  buildWhereRhs,
  cypherOpToSql,
  isWriteQuery,
  mergeCondition,
  pushWhereParam,
  resolveColumnExpression,
  sanitizeIdentifier,
} from './cypherEngineSqlHelpers';

describe('cypherEngineSqlHelpers', () => {
  describe('resolveColumnExpression', () => {
    it('maps known property names to alias.column refs', () => {
      expect(resolveColumnExpression('n', 'name')).toBe('n.name');
      expect(resolveColumnExpression('n', 'file_path')).toBe('n.file_path');
    });

    it('maps camelCase aliases to snake_case SQL columns', () => {
      expect(resolveColumnExpression('n', 'filePath')).toBe('n.file_path');
      expect(resolveColumnExpression('n', 'qualifiedName')).toBe('n.qualified_name');
    });

    it('falls through to json_extract for unknown properties (props.* keys)', () => {
      expect(resolveColumnExpression('n', 'signature')).toBe(
        "json_extract(n.props, '$.signature')",
      );
      expect(resolveColumnExpression('n', 'custom_prop')).toBe(
        "json_extract(n.props, '$.custom_prop')",
      );
    });

    it('sanitizes the JSON path key against injection', () => {
      // Keys that would otherwise inject quote/SQL fragments are stripped to alphanumerics
      expect(resolveColumnExpression('n', "evil'; DROP TABLE")).toBe(
        "json_extract(n.props, '$.evilDROPTABLE')",
      );
    });
  });

  describe('cypherOpToSql', () => {
    it('maps CONTAINS to LIKE', () => {
      expect(cypherOpToSql('CONTAINS')).toBe('LIKE');
    });

    it('maps STARTS WITH to LIKE', () => {
      expect(cypherOpToSql('STARTS WITH')).toBe('LIKE');
    });

    it('maps ENDS WITH to LIKE', () => {
      expect(cypherOpToSql('ENDS WITH')).toBe('LIKE');
    });

    it('maps = to =', () => {
      expect(cypherOpToSql('=')).toBe('=');
    });

    it('maps <> to <>', () => {
      expect(cypherOpToSql('<>')).toBe('<>');
    });

    it('maps comparison operators correctly', () => {
      expect(cypherOpToSql('>')).toBe('>');
      expect(cypherOpToSql('<')).toBe('<');
      expect(cypherOpToSql('>=')).toBe('>=');
      expect(cypherOpToSql('<=')).toBe('<=');
    });

    it('maps IN to IN', () => {
      expect(cypherOpToSql('IN')).toBe('IN');
    });

    it('defaults unknown operators to =', () => {
      expect(cypherOpToSql('INVALID')).toBe('=');
    });
  });

  describe('buildOrderBy', () => {
    it('returns empty string for empty array', () => {
      expect(buildOrderBy([])).toBe('');
    });

    it('builds ORDER BY clause for single field', () => {
      const result = buildOrderBy([{ alias: 'n', property: 'name', direction: 'ASC' }]);
      expect(result).toBe('n.name ASC');
    });

    it('builds ORDER BY clause for multiple fields', () => {
      const result = buildOrderBy([
        { alias: 'n', property: 'name', direction: 'ASC' },
        { alias: 'm', property: 'file_path', direction: 'DESC' },
      ]);
      expect(result).toBe('n.name ASC, m.file_path DESC');
    });
  });

  describe('buildWhereRhs', () => {
    it('returns a single placeholder for scalar operators', () => {
      expect(
        buildWhereRhs({
          alias: 'n',
          property: 'name',
          operator: '=',
          value: 'foo',
          conjunction: null,
        }),
      ).toBe('?');
      expect(
        buildWhereRhs({
          alias: 'n',
          property: 'name',
          operator: 'CONTAINS',
          value: 'foo',
          conjunction: null,
        }),
      ).toBe('?');
    });

    it('returns a parenthesized list of placeholders for IN operator', () => {
      expect(
        buildWhereRhs({
          alias: 'n',
          property: 'label',
          operator: 'IN',
          value: ['Class', 'Function', 'Method'],
          conjunction: null,
        }),
      ).toBe('(?, ?, ?)');
    });

    it('returns (NULL) for empty IN lists so the predicate matches nothing', () => {
      expect(
        buildWhereRhs({
          alias: 'n',
          property: 'label',
          operator: 'IN',
          value: [],
          conjunction: null,
        }),
      ).toBe('(NULL)');
    });
  });

  describe('mergeCondition', () => {
    it('appends condition with AND by default', () => {
      const conditions: string[] = ['a = 1'];
      mergeCondition(conditions, 'b = 2', 'AND');
      expect(conditions).toEqual(['a = 1', 'b = 2']);
    });

    it('collapses OR pairs into parenthesized expression', () => {
      const conditions: string[] = ['a = 1'];
      mergeCondition(conditions, 'b = 2', 'OR');
      expect(conditions).toEqual(['(a = 1 OR b = 2)']);
    });

    it('appends condition when prevConjunction is null', () => {
      const conditions: string[] = [];
      mergeCondition(conditions, 'a = 1', null);
      expect(conditions).toEqual(['a = 1']);
    });
  });

  describe('pushWhereParam', () => {
    it('wraps CONTAINS value with % on both sides', () => {
      const params: unknown[] = [];
      pushWhereParam(params, {
        alias: 'n',
        property: 'name',
        operator: 'CONTAINS',
        value: 'foo',
        conjunction: null,
      });
      expect(params).toEqual(['%foo%']);
    });

    it('wraps STARTS WITH value with trailing %', () => {
      const params: unknown[] = [];
      pushWhereParam(params, {
        alias: 'n',
        property: 'name',
        operator: 'STARTS WITH',
        value: 'foo',
        conjunction: null,
      });
      expect(params).toEqual(['foo%']);
    });

    it('wraps ENDS WITH value with leading %', () => {
      const params: unknown[] = [];
      pushWhereParam(params, {
        alias: 'n',
        property: 'name',
        operator: 'ENDS WITH',
        value: 'foo',
        conjunction: null,
      });
      expect(params).toEqual(['%foo']);
    });

    it('passes through value unchanged for equality operators', () => {
      const params: unknown[] = [];
      pushWhereParam(params, {
        alias: 'n',
        property: 'name',
        operator: '=',
        value: 'foo',
        conjunction: null,
      });
      expect(params).toEqual(['foo']);
    });

    it('expands array values into separate params for IN operator', () => {
      const params: unknown[] = [];
      pushWhereParam(params, {
        alias: 'n',
        property: 'label',
        operator: 'IN',
        value: ['Class', 'Function', 'Method'],
        conjunction: null,
      });
      expect(params).toEqual(['Class', 'Function', 'Method']);
    });

    it('handles a scalar value for IN operator by wrapping it once', () => {
      const params: unknown[] = [];
      pushWhereParam(params, {
        alias: 'n',
        property: 'label',
        operator: 'IN',
        value: 'Class',
        conjunction: null,
      });
      expect(params).toEqual(['Class']);
    });

    it('coerces ISO date string to epoch ms for indexed_at', () => {
      const params: unknown[] = [];
      pushWhereParam(params, {
        alias: 'p',
        property: 'indexed_at',
        operator: '>',
        value: '2024-01-01',
        conjunction: null,
      });
      expect(typeof params[0]).toBe('number');
      expect(params[0]).toBe(Date.parse('2024-01-01'));
    });

    it('coerces ISO datetime string to epoch ms for indexedAt (camelCase)', () => {
      const params: unknown[] = [];
      pushWhereParam(params, {
        alias: 'p',
        property: 'indexedAt',
        operator: '>=',
        value: '2024-06-15T12:00:00Z',
        conjunction: null,
      });
      expect(typeof params[0]).toBe('number');
      expect(params[0]).toBe(Date.parse('2024-06-15T12:00:00Z'));
    });

    it('does not coerce ISO string for non-indexed_at properties', () => {
      const params: unknown[] = [];
      pushWhereParam(params, {
        alias: 'n',
        property: 'name',
        operator: '=',
        value: '2024-01-01',
        conjunction: null,
      });
      expect(params[0]).toBe('2024-01-01');
    });

    it('coerces ISO dates inside IN list for indexed_at', () => {
      const params: unknown[] = [];
      pushWhereParam(params, {
        alias: 'p',
        property: 'indexed_at',
        operator: 'IN',
        value: ['2024-01-01', '2024-06-01'],
        conjunction: null,
      });
      expect(params).toEqual([Date.parse('2024-01-01'), Date.parse('2024-06-01')]);
    });
  });

  describe('isWriteQuery', () => {
    it('identifies CREATE as a write query', () => {
      expect(isWriteQuery('CREATE (n:Node)')).toBe(true);
    });

    it('identifies DELETE as a write query', () => {
      expect(isWriteQuery('DELETE n')).toBe(true);
    });

    it('identifies MERGE as a write query', () => {
      expect(isWriteQuery('MERGE (n:Node {id: 1})')).toBe(true);
    });

    it('allows MATCH queries', () => {
      expect(isWriteQuery('MATCH (n:Node) RETURN n')).toBe(false);
    });
  });

  describe('sanitizeIdentifier', () => {
    it('strips non-alphanumeric/underscore characters', () => {
      expect(sanitizeIdentifier('CALLS')).toBe('CALLS');
      expect(sanitizeIdentifier('IMPORT_FROM')).toBe('IMPORT_FROM');
    });

    it('removes special characters', () => {
      expect(sanitizeIdentifier("'; DROP TABLE")).toBe('DROP TABLE'.replace(' ', ''));
    });
  });
});

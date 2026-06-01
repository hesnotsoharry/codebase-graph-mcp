import { describe, expect, it } from 'vitest';

import { rootHash } from './serverBootstrap';

/**
 * Regression for the duplicate-project bug (2026-06-01): the same folder, spelled with
 * backslashes vs forward slashes, used to hash to two different ~/.codebase-graph DBs and
 * index the project twice. rootHash() must canonicalize them to a single hash.
 */
describe('rootHash canonicalization', () => {
  it('maps backslash and forward-slash spellings of one folder to the same hash', () => {
    expect(rootHash('C:\\Web App\\Gamify')).toBe(rootHash('C:/Web App/Gamify'));
  });

  it('folds trailing slash and drive-letter case', () => {
    expect(rootHash('C:/Web App/Gamify/')).toBe(rootHash('c:/web app/gamify'));
  });

  it('still distinguishes genuinely different roots', () => {
    expect(rootHash('C:/Web App/Gamify')).not.toBe(rootHash('C:/Web App/meta'));
  });
});

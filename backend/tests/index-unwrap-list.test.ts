import { describe, expect, test } from 'bun:test';
import { unwrapIndexList } from '../src/lib/renaiss-index/schemas.ts';

describe('unwrapIndexList', () => {
  test('unwraps bare array', () => {
    expect(unwrapIndexList([{ a: 1 }])).toEqual([{ a: 1 }]);
  });

  test('unwraps { trades: [...] } live shape', () => {
    const rows = [{ id: 'x' }];
    expect(unwrapIndexList({ trades: rows })).toEqual(rows);
  });

  test('unwraps { results: [...] } search shape', () => {
    const rows = [{ name: 'Charizard' }];
    expect(unwrapIndexList({ query: 'c', results: rows })).toEqual(rows);
  });

  test('returns empty for unknown wrapper', () => {
    expect(unwrapIndexList({ foo: [] })).toEqual([]);
  });
});

/**
 * parsePriceCents tests. The single most important number-coercion helper in
 * the codebase: every USD value from the Renaiss main API (string cents) or
 * the Renaiss Index API (integer cents) passes through here. A bug here would
 * silently corrupt FMV, leaderboard, and odds math.
 */

import { describe, test, expect } from 'bun:test';

import { parsePriceCents } from '../src/lib/renaiss/types.ts';

describe('parsePriceCents', () => {
  test('string "7350" returns 7350 (main API shape)', () => {
    expect(parsePriceCents('7350')).toBe(7350);
  });

  test('integer 7350 returns 7350 (Index API shape)', () => {
    expect(parsePriceCents(7350)).toBe(7350);
  });

  test('null returns null', () => {
    expect(parsePriceCents(null)).toBeNull();
  });

  test('undefined returns null', () => {
    expect(parsePriceCents(undefined)).toBeNull();
  });

  test('empty string returns null', () => {
    expect(parsePriceCents('')).toBeNull();
  });

  test('non-numeric string returns null', () => {
    expect(parsePriceCents('not a number')).toBeNull();
  });

  test('decimal string is rejected (integer cents contract)', () => {
    // Implementation rejects decimals: the upstream contract is integer cents.
    expect(parsePriceCents('7350.5')).toBeNull();
  });

  test('decimal number is truncated via Math.trunc', () => {
    expect(parsePriceCents(7350.9)).toBe(7350);
  });

  test('0 returns 0 (free pulls / zero-cost trades)', () => {
    expect(parsePriceCents(0)).toBe(0);
    expect(parsePriceCents('0')).toBe(0);
  });

  test('negative integer string is accepted as-is', () => {
    // Documented behavior: the regex /^-?\d+$/ allows negatives. Pulls
    // cannot be negative in practice, but the helper does not enforce that
    // (callers do, via business logic). This test pins the current behavior.
    expect(parsePriceCents('-100')).toBe(-100);
    expect(parsePriceCents(-100)).toBe(-100);
  });

  test('NaN number returns null', () => {
    expect(parsePriceCents(NaN)).toBeNull();
  });

  test('Infinity returns null', () => {
    expect(parsePriceCents(Infinity)).toBeNull();
    expect(parsePriceCents(-Infinity)).toBeNull();
  });

  test('whitespace-padded numeric string is parsed', () => {
    expect(parsePriceCents('  7350  ')).toBe(7350);
  });
});

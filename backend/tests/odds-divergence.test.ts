/**
 * Tests for the pure kernels behind the dual-window odds surface:
 *   - computeTierFrequency
 *   - computeDivergence
 *
 * Rationale: the wall around the odds route is that we NEVER invent an
 * "official odds" number; both windows are empirical and both must be shown
 * side-by-side with a divergence flag. These kernels are what decide when the
 * flag fires, so they carry the honest-data contract.
 */

import { describe, expect, test } from 'bun:test';

import {
  computeDivergence,
  computeTierFrequency,
} from '../src/lib/odds/tier-frequency.ts';

describe('computeTierFrequency', () => {
  test('lowercases and buckets identical tiers regardless of case', () => {
    const out = computeTierFrequency(['Rare', 'rare', 'RARE', 'common']);
    expect(out.total).toBe(4);
    const rare = out.entries.find((e) => e.tier === 'rare');
    const common = out.entries.find((e) => e.tier === 'common');
    expect(rare?.count).toBe(3);
    expect(common?.count).toBe(1);
    expect(rare?.pct).toBeCloseTo(0.75, 5);
    expect(common?.pct).toBeCloseTo(0.25, 5);
  });

  test('skips null, undefined, empty, non-string entries', () => {
    const out = computeTierFrequency([
      null,
      undefined,
      '',
      '  ',
      'rare',
      // @ts-expect-error - deliberately invalid to prove the guard
      42,
    ]);
    expect(out.total).toBe(1);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].tier).toBe('rare');
    expect(out.entries[0].pct).toBeCloseTo(1, 5);
  });

  test('entries are sorted by count DESC', () => {
    const out = computeTierFrequency([
      'common',
      'common',
      'common',
      'rare',
      'legendary',
      'legendary',
    ]);
    expect(out.entries.map((e) => e.tier)).toEqual([
      'common',
      'legendary',
      'rare',
    ]);
  });

  test('empty input returns total=0 and no entries', () => {
    const out = computeTierFrequency([]);
    expect(out.total).toBe(0);
    expect(out.entries).toHaveLength(0);
  });
});

describe('computeDivergence', () => {
  test('per-tier delta is upstream minus empirical in percentage points', () => {
    const upstream = [
      { tier: 'rare', count: 15, pct: 0.5 },
      { tier: 'common', count: 15, pct: 0.5 },
    ];
    const empirical = [
      { tier: 'rare', count: 10, pct: 0.1 },
      { tier: 'common', count: 90, pct: 0.9 },
    ];
    const divergence = computeDivergence(upstream, empirical, 20);
    const rare = divergence.find((d) => d.tier === 'rare');
    const common = divergence.find((d) => d.tier === 'common');
    // rare: 50% upstream vs 10% empirical = +40 pp
    expect(rare?.deltaPct).toBe(40);
    expect(rare?.flagged).toBe(true);
    // common: 50% upstream vs 90% empirical = -40 pp
    expect(common?.deltaPct).toBe(-40);
    expect(common?.flagged).toBe(true);
  });

  test('deltas at or below threshold do NOT flag', () => {
    const upstream = [{ tier: 'rare', count: 3, pct: 0.3 }];
    const empirical = [{ tier: 'rare', count: 5, pct: 0.5 }];
    // |0.3 - 0.5| = 20 pp; threshold is 20; strict > means NOT flagged.
    const divergence = computeDivergence(upstream, empirical, 20);
    expect(divergence[0].flagged).toBe(false);
    expect(divergence[0].deltaPct).toBe(-20);
  });

  test('tiers present in only one window still emit an entry with pct=0 for the missing side', () => {
    const upstream = [{ tier: 'legendary', count: 1, pct: 1.0 }];
    const empirical = [{ tier: 'common', count: 1, pct: 1.0 }];
    const divergence = computeDivergence(upstream, empirical, 20);
    const legendary = divergence.find((d) => d.tier === 'legendary');
    const common = divergence.find((d) => d.tier === 'common');
    expect(legendary?.upstreamPct).toBe(1);
    expect(legendary?.empiricalPct).toBe(0);
    expect(legendary?.flagged).toBe(true);
    expect(common?.upstreamPct).toBe(0);
    expect(common?.empiricalPct).toBe(1);
    expect(common?.flagged).toBe(true);
  });

  test('output is sorted by absolute delta DESC', () => {
    const upstream = [
      { tier: 'a', count: 1, pct: 0.5 }, // delta 10
      { tier: 'b', count: 1, pct: 0.9 }, // delta 50
      { tier: 'c', count: 1, pct: 0.3 }, // delta -30
    ];
    const empirical = [
      { tier: 'a', count: 1, pct: 0.4 },
      { tier: 'b', count: 1, pct: 0.4 },
      { tier: 'c', count: 1, pct: 0.6 },
    ];
    const divergence = computeDivergence(upstream, empirical, 20);
    expect(divergence.map((d) => d.tier)).toEqual(['b', 'c', 'a']);
  });

  test('empty inputs return an empty array', () => {
    expect(computeDivergence([], [], 20)).toEqual([]);
  });

  test('custom threshold is respected', () => {
    const upstream = [{ tier: 'rare', count: 1, pct: 0.15 }];
    const empirical = [{ tier: 'rare', count: 1, pct: 0.05 }];
    // delta 10 pp; threshold 5 pp -> flagged.
    const d5 = computeDivergence(upstream, empirical, 5);
    expect(d5[0].flagged).toBe(true);
    // threshold 15 pp -> NOT flagged.
    const d15 = computeDivergence(upstream, empirical, 15);
    expect(d15[0].flagged).toBe(false);
  });
});

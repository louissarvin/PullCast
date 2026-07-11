/**
 * D8 schema validation tests.
 *
 * Loads the fixtures we captured from the live Renaiss OS Index API on
 * 2026-07-02 and runs them through the zod schemas in
 * `src/lib/renaiss-index/schemas.ts`. If the upstream shape drifts, these
 * tests fail loud so the client cannot silently accept a new payload.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  indicesResponseSchema,
  indexDetailSchema,
  featuredResponseSchema,
  indexTileSchema,
  cardSummarySchema,
} from '../src/lib/renaiss-index/schemas.ts';

const readFixture = (name: string): unknown => {
  const path = resolve(process.cwd(), 'tests', 'fixtures', 'renaiss-index', name);
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
};

describe('D8 Renaiss OS Index schemas — live fixture validation', () => {
  test('indicesResponseSchema accepts /v1/indices fixture', () => {
    const fixture = readFixture('indices.json');
    const result = indicesResponseSchema.safeParse(fixture);
    if (!result.success) {
      // Surface the first error for easier debugging when the upstream drifts.
      console.error('indicesResponseSchema parse error:', result.error.issues[0]);
    }
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Array.isArray(result.data.indices)).toBe(true);
      expect(result.data.indices.length).toBeGreaterThan(0);
      const pokemon = result.data.indices.find((t) => t.game === 'pokemon');
      expect(pokemon).toBeDefined();
      if (pokemon) {
        expect(typeof pokemon.value).toBe('number');
        expect(pokemon.value).toBeGreaterThan(0);
        expect(pokemon.sparkline.length).toBeGreaterThan(0);
      }
    }
  });

  test('indexDetailSchema accepts /v1/indices/pokemon fixture', () => {
    const fixture = readFixture('indices-pokemon.json');
    const result = indexDetailSchema.safeParse(fixture);
    if (!result.success) {
      console.error('indexDetailSchema parse error:', result.error.issues[0]);
    }
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.game).toBe('pokemon');
      expect(typeof result.data.windowDays).toBe('number');
      expect(Array.isArray(result.data.constituents)).toBe(true);
    }
  });

  test('featuredResponseSchema accepts /v1/cards/featured fixture', () => {
    const fixture = readFixture('featured.json');
    const result = featuredResponseSchema.safeParse(fixture);
    if (!result.success) {
      console.error('featuredResponseSchema parse error:', result.error.issues[0]);
    }
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Array.isArray(result.data.cards)).toBe(true);
      expect(result.data.cards.length).toBeGreaterThan(0);
      const first = result.data.cards[0];
      expect(typeof first.name).toBe('string');
      expect(typeof first.href).toBe('string');
      expect(typeof first.gradeLabel).toBe('string');
    }
  });
});

describe('D8 schema edge cases', () => {
  test('indexTileSchema rejects unknown game slug', () => {
    const bad = {
      game: 'yugioh',
      label: 'Yu-Gi-Oh Index',
      value: 100,
      base: 100,
      deltas: { d7: 0, d30: 0, d365: 0 },
      constituentCount: 0,
      rebalance: 'Monthly',
      sparkline: [],
      topMovers: [],
      updatedAt: null,
    };
    expect(indexTileSchema.safeParse(bad).success).toBe(false);
  });

  test('indexTileSchema accepts null deltas', () => {
    const goodWithNullDeltas = {
      game: 'sports',
      label: 'Sports Index',
      value: 10000,
      base: 10000,
      deltas: { d7: null, d30: null, d365: null },
      constituentCount: 10,
      rebalance: 'Monthly',
      sparkline: [
        { t: '2026-06-01T00:00:00Z', usdCents: 100000 },
      ],
      topMovers: [],
      updatedAt: '2026-07-01T00:00:00Z',
    };
    const r = indexTileSchema.safeParse(goodWithNullDeltas);
    if (!r.success) console.error(r.error.issues[0]);
    expect(r.success).toBe(true);
  });

  test('cardSummarySchema rejects negative priceUsdCents', () => {
    const bad = {
      game: 'pokemon',
      type: 'POKEMON',
      name: 'X',
      setName: null,
      setCode: null,
      cardNumber: null,
      variation: null,
      language: null,
      imageUrl: null,
      company: 'PSA',
      grade: '10 Gem Mint',
      gradeLabel: 'PSA 10',
      priceUsdCents: -1,
      deltaPct: 0,
      confidence: 'low',
      lastSaleAt: null,
      href: '/card/x',
    };
    expect(cardSummarySchema.safeParse(bad).success).toBe(false);
  });

  test('cardSummarySchema accepts null priceUsdCents', () => {
    const good = {
      game: 'pokemon',
      type: 'POKEMON',
      name: 'X',
      setName: null,
      setCode: null,
      cardNumber: null,
      variation: null,
      language: null,
      imageUrl: null,
      company: 'PSA',
      grade: null,
      gradeLabel: 'PSA 10',
      priceUsdCents: null,
      deltaPct: null,
      confidence: null,
      lastSaleAt: null,
      href: '/card/x',
    };
    const r = cardSummarySchema.safeParse(good);
    if (!r.success) console.error(r.error.issues[0]);
    expect(r.success).toBe(true);
  });
});

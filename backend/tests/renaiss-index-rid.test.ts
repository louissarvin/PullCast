/**
 * D9: schema-validation and behavior tests for the by-renaiss-id endpoints.
 *
 * Every by-renaiss-id fixture in `tests/fixtures/renaiss-index/` was captured
 * from the live Renaiss OS Index API on 2026-07-03. When upstream drifts, the
 * schemas will fail these tests loudly rather than silently accept a new
 * payload shape.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  indexCardDetailSchema,
  indexCardDetailOverviewSchema,
  indexCardTradesResponseSchema,
  indexCardSeriesResponseSchema,
  indexCardFmvSeriesResponseSchema,
} from '../src/lib/renaiss-index/schemas.ts';

const readFixture = (name: string): unknown => {
  const path = resolve(process.cwd(), 'tests', 'fixtures', 'renaiss-index', name);
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
};

describe('D9 by-renaiss-id schema validation — live fixtures 2026-07-03', () => {
  test('indexCardDetailSchema accepts /v1/cards/by-renaiss-id/{rid} fixture', () => {
    const fixture = readFixture('by-renaiss-id-detail.json');
    const result = indexCardDetailSchema.safeParse(fixture);
    if (!result.success) {
      console.error('indexCardDetailSchema parse error:', result.error.issues[0]);
    }
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.id).toBe('string');
      expect(result.data.game).toBe('pokemon');
      expect(typeof result.data.name).toBe('string');
      expect(typeof result.data.priceUsdCents === 'number' || result.data.priceUsdCents === null).toBe(true);
      expect(typeof result.data.href).toBe('string');
      // Live fixture has `id` UUID.
      expect(/^[0-9a-f-]{36}$/i.test(result.data.id)).toBe(true);
    }
  });

  test('indexCardDetailOverviewSchema accepts /overview fixture', () => {
    const fixture = readFixture('by-renaiss-id-overview.json');
    const result = indexCardDetailOverviewSchema.safeParse(fixture);
    if (!result.success) {
      console.error('indexCardDetailOverviewSchema parse error:', result.error.issues[0]);
    }
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.game).toBe('pokemon');
      expect(typeof result.data.gradeCount).toBe('number');
      expect(Array.isArray(result.data.grades)).toBe(true);
      expect(result.data.grades.length).toBeGreaterThan(0);
    }
  });

  test('indexCardTradesResponseSchema accepts /trades fixture', () => {
    const fixture = readFixture('by-renaiss-id-trades.json');
    const result = indexCardTradesResponseSchema.safeParse(fixture);
    if (!result.success) {
      console.error('indexCardTradesResponseSchema parse error:', result.error.issues[0]);
    }
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Array.isArray(result.data.trades)).toBe(true);
      expect(typeof result.data.total).toBe('number');
      if (result.data.trades.length > 0) {
        const t = result.data.trades[0];
        expect(typeof t.source).toBe('string');
        expect(typeof t.observedAt).toBe('string');
      }
    }
  });

  test('indexCardSeriesResponseSchema accepts /series fixture', () => {
    const fixture = readFixture('by-renaiss-id-series.json');
    const result = indexCardSeriesResponseSchema.safeParse(fixture);
    if (!result.success) {
      console.error('indexCardSeriesResponseSchema parse error:', result.error.issues[0]);
    }
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.windowDays).toBe('number');
      expect(Array.isArray(result.data.points)).toBe(true);
      expect(result.data.points.length).toBeGreaterThan(0);
      const p = result.data.points[0];
      expect(typeof p.t).toBe('string');
      expect(typeof p.usdCents).toBe('number');
    }
  });

  test('indexCardFmvSeriesResponseSchema accepts /fmv-series fixture', () => {
    const fixture = readFixture('by-renaiss-id-fmv-series.json');
    const result = indexCardFmvSeriesResponseSchema.safeParse(fixture);
    if (!result.success) {
      console.error('indexCardFmvSeriesResponseSchema parse error:', result.error.issues[0]);
    }
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.windowDays).toBe('number');
      expect(typeof result.data.fmvWindowDays).toBe('number');
      expect(Array.isArray(result.data.points)).toBe(true);
      expect(Array.isArray(result.data.series)).toBe(true);
      // Three method series expected: median, mean, vwap.
      const methods = result.data.series.map((s) => s.method);
      expect(methods).toContain('median');
      expect(methods).toContain('mean');
      expect(methods).toContain('vwap');
    }
  });

  test('rid-not-found: schema rejects an ApiError body via missing required fields', () => {
    // Simulate a 404 body that the client would surface as IndexApiError, not
    // pass through the schema. The schema should reject an ApiError shape so
    // no silent-through of an error body ever happens.
    const errorLike = { error: 'unknown_rid', code: 'NOT_FOUND' };
    const result = indexCardDetailSchema.safeParse(errorLike);
    expect(result.success).toBe(false);
  });

  test('extra/unknown top-level fields survive via passthrough (additive drift)', () => {
    const fixture = readFixture('by-renaiss-id-detail.json') as Record<
      string,
      unknown
    >;
    const withExtras = { ...fixture, futureField: 'someValue', promoBadge: 42 };
    const result = indexCardDetailSchema.safeParse(withExtras);
    expect(result.success).toBe(true);
    if (result.success) {
      const parsed = result.data as Record<string, unknown>;
      expect(parsed.futureField).toBe('someValue');
      expect(parsed.promoBadge).toBe(42);
    }
  });

  test('detail schema tolerates null nested fields (setName, cardNumber, imageUrl)', () => {
    // Constructed edge case: a card with sparse metadata where nullable fields
    // are actually null (not simply missing).
    const sparse = {
      id: '00000000-0000-0000-0000-000000000000',
      game: 'sports',
      type: 'SPORTS',
      name: 'Sparse Card',
      setName: null,
      setCode: null,
      cardNumber: null,
      variation: null,
      language: null,
      imageUrl: null,
      imageUrlLg: null,
      company: null,
      grade: null,
      gradeLabel: 'Ungraded',
      priceUsdCents: null,
      deltas: { d7: null, d30: null, d365: null },
      confidence: null,
      updatedAt: null,
      lastSaleAt: null,
      refreshing: false,
      sourceBreakdown: [],
      sourceBreakdownAllTime: [],
      href: '/card/sports/foo/bar',
    };
    const result = indexCardDetailSchema.safeParse(sparse);
    expect(result.success).toBe(true);
  });
});

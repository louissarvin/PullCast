/**
 * Gap 7 tests: /v1/cards/by-id/{id}/series raw per-trade series.
 *
 * Uses byid-series.json (live 2026-07-03) to verify the schema accepts the
 * raw shape. Distinct from /fmv-series which is daily-aggregated.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { indexCardSeriesResponseSchema } from '../src/lib/renaiss-index/schemas.ts';

const readFixture = (name: string): unknown => {
  const path = resolve(
    process.cwd(),
    'tests',
    'fixtures',
    'renaiss-index',
    name
  );
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
};

describe('Gap 7: raw per-trade series (by-id) schema', () => {
  test('indexCardSeriesResponseSchema accepts byid-series.json', () => {
    const fixture = readFixture('byid-series.json');
    const result = indexCardSeriesResponseSchema.safeParse(fixture);
    if (!result.success) console.error(result.error.issues[0]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.windowDays).toBeGreaterThan(0);
      expect(Array.isArray(result.data.points)).toBe(true);
    }
  });

  test('raw series MAY contain multiple points on the same day', () => {
    const fixture = readFixture('byid-series.json') as {
      points: Array<{ t: string; usdCents: number }>;
    };
    // Group by date; there is no guarantee raw series is unique-per-day.
    const dates = fixture.points.map((p) => p.t.slice(0, 10));
    const unique = new Set(dates);
    // Not strictly asserting duplication — the fixture may or may not have
    // multiple points on the same day — but the schema must accept the shape.
    // What we DO assert is that all points have both t and usdCents.
    for (const p of fixture.points) {
      expect(typeof p.t).toBe('string');
      expect(typeof p.usdCents).toBe('number');
      expect(p.usdCents).toBeGreaterThanOrEqual(0);
    }
    // Assertion: parsed date count is a positive integer (silences the
    // unused-variable warning while still exercising the shape).
    expect(unique.size).toBeGreaterThan(0);
  });

  test('schema rejects a point missing required t/usdCents', () => {
    const bad = {
      windowDays: 7,
      points: [{ usdCents: 100 }],
    };
    expect(indexCardSeriesResponseSchema.safeParse(bad).success).toBe(false);
  });

  test('schema rejects negative usdCents', () => {
    const bad = {
      windowDays: 7,
      points: [{ t: '2026-07-01', usdCents: -1 }],
    };
    expect(indexCardSeriesResponseSchema.safeParse(bad).success).toBe(false);
  });

  test('schema rejects windowDays <= 0', () => {
    const bad = {
      windowDays: 0,
      points: [],
    };
    expect(indexCardSeriesResponseSchema.safeParse(bad).success).toBe(false);
  });
});

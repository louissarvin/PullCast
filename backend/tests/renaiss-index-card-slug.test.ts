/**
 * Gap 4 tests: /v1/cards/{game}/{set}/{card} family — schemas + href parser.
 *
 * We validate the 4 slug-family fixtures captured live 2026-07-03 against
 * their existing schemas:
 *   - card-slug-detail.json      -> indexCardDetailSchema
 *   - card-slug-overview.json    -> indexCardDetailOverviewSchema
 *   - card-slug-trades.json      -> indexCardTradesResponseSchema
 *   - card-slug-series.json      -> indexCardSeriesResponseSchema
 *   - card-slug-fmv-series.json  -> indexCardFmvSeriesResponseSchema
 *
 * We also test the href parser and stripGradeSuffix helper.
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
import {
  parseCardHref,
  stripGradeSuffix,
} from '../src/lib/renaiss-index/href.ts';

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

describe('Gap 4: slug-family schemas (live fixtures)', () => {
  test('indexCardDetailSchema accepts card-slug-detail.json', () => {
    const fixture = readFixture('card-slug-detail.json');
    const result = indexCardDetailSchema.safeParse(fixture);
    if (!result.success) console.error(result.error.issues[0]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.id).toBe('string');
      expect(result.data.game).toBe('pokemon');
      expect(typeof result.data.gradeLabel).toBe('string');
    }
  });

  test('indexCardDetailOverviewSchema accepts card-slug-overview.json', () => {
    const fixture = readFixture('card-slug-overview.json');
    const result = indexCardDetailOverviewSchema.safeParse(fixture);
    if (!result.success) console.error(result.error.issues[0]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gradeCount).toBeGreaterThan(0);
      expect(result.data.grades.length).toBe(result.data.gradeCount);
      expect(typeof result.data.grades[0].gradeLabel).toBe('string');
    }
  });

  test('indexCardTradesResponseSchema accepts card-slug-trades.json', () => {
    const fixture = readFixture('card-slug-trades.json');
    const result = indexCardTradesResponseSchema.safeParse(fixture);
    if (!result.success) console.error(result.error.issues[0]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.total).toBe('number');
      expect(Array.isArray(result.data.trades)).toBe(true);
      if (result.data.trades.length > 0) {
        const first = result.data.trades[0];
        expect(['listing', 'transaction']).toContain(first.kind);
      }
    }
  });

  test('indexCardSeriesResponseSchema accepts card-slug-series.json', () => {
    const fixture = readFixture('card-slug-series.json');
    const result = indexCardSeriesResponseSchema.safeParse(fixture);
    if (!result.success) console.error(result.error.issues[0]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.windowDays).toBeGreaterThan(0);
      expect(Array.isArray(result.data.points)).toBe(true);
    }
  });

  test('indexCardFmvSeriesResponseSchema accepts card-slug-fmv-series.json', () => {
    const fixture = readFixture('card-slug-fmv-series.json');
    const result = indexCardFmvSeriesResponseSchema.safeParse(fixture);
    if (!result.success) console.error(result.error.issues[0]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.windowDays).toBeGreaterThan(0);
      expect(result.data.fmvWindowDays).toBeGreaterThan(0);
      expect(Array.isArray(result.data.series)).toBe(true);
    }
  });
});

describe('Gap 4: href parser', () => {
  test('parseCardHref splits /card/{game}/{set}/{card}', () => {
    const r = parseCardHref('/card/pokemon/pokemon-ex-unseen-forces/114-raikou-holo-psa-10-fbd95fe2');
    expect(r).not.toBeNull();
    expect(r?.game).toBe('pokemon');
    expect(r?.setCode).toBe('pokemon-ex-unseen-forces');
    expect(r?.cardSlug).toBe('114-raikou-holo-psa-10-fbd95fe2');
  });

  test('parseCardHref handles absolute URLs', () => {
    const r = parseCardHref('https://renaissos.com/card/one-piece/op04/112-yamato-psa-10-c9dd04ec');
    expect(r).not.toBeNull();
    expect(r?.game).toBe('one-piece');
    expect(r?.setCode).toBe('op04');
    expect(r?.cardSlug).toBe('112-yamato-psa-10-c9dd04ec');
  });

  test('parseCardHref returns null on malformed input', () => {
    expect(parseCardHref('/notacard/x')).toBeNull();
    expect(parseCardHref('')).toBeNull();
    expect(parseCardHref(undefined)).toBeNull();
    expect(parseCardHref(null)).toBeNull();
    expect(parseCardHref(42)).toBeNull();
  });

  test('parseCardHref preserves query string strip', () => {
    const r = parseCardHref('/card/pokemon/base-set/4-charizard-psa-10?foo=bar');
    expect(r).not.toBeNull();
    expect(r?.cardSlug).toBe('4-charizard-psa-10');
  });

  test('stripGradeSuffix removes -psa-10 and short hash', () => {
    expect(stripGradeSuffix('114-raikou-holo-psa-10-fbd95fe2')).toBe('114-raikou-holo');
    expect(stripGradeSuffix('307-charizard-psa-10')).toBe('307-charizard');
    expect(stripGradeSuffix('001-monkey-d-luffy-psa-10-japanese-ea3f53da')).toContain('monkey-d-luffy');
  });

  test('stripGradeSuffix is a no-op for slugs without a recognizable grade suffix', () => {
    // If nothing matches we get the input back (or a minimally-clipped version).
    // A 2-token slug is guaranteed to pass through untouched.
    expect(stripGradeSuffix('foo-bar')).toBe('foo-bar');
  });

  test('every href in card-slug-detail.json is parseable', () => {
    const fixture = readFixture('card-slug-detail.json') as {
      href: string;
      otherGrades?: Array<{ href: string }>;
    };
    const primary = parseCardHref(fixture.href);
    expect(primary).not.toBeNull();
    if (Array.isArray(fixture.otherGrades)) {
      for (const g of fixture.otherGrades) {
        expect(parseCardHref(g.href)).not.toBeNull();
      }
    }
  });
});

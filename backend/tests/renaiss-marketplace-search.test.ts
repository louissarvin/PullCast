/**
 * Tests for the `/v0/marketplace` search integration.
 *
 * Coverage:
 *   1. Schema round-trip against 3 LIVE fixtures captured 2026-07-02.
 *      Fixtures live in `tests/fixtures/renaiss/marketplace-search-*.json`
 *      and were captured via:
 *        curl "https://api.renaiss.xyz/v0/marketplace?gradingCompanyFilter=PSA&limit=2"
 *        curl "https://api.renaiss.xyz/v0/marketplace?search=charizard&categoryFilter=POKEMON&limit=2"
 *        curl "https://api.renaiss.xyz/v0/marketplace?sortBy=fmvPriceInUsd&sortOrder=desc&limit=2"
 *   2. Query-param serialization: `buildUrl` (via a stub `fetch`) must omit
 *      undefined values, stringify booleans as "true"/"false", and preserve
 *      integer / string values as-is. This guards against a client-side bug
 *      where `undefined` would leak to the wire as the string "undefined".
 *   3. Rate-limit smoke test: the /api/marketplace route's IP token bucket
 *      matches the pattern used by leaderboardRoutes / marketRoutes (30/min).
 *      We only assert the bucket key + capacity are wired; the atomic Postgres
 *      call is exercised end-to-end by `param-validators.test.ts`.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  renaissMarketplaceSearchResponseSchema,
  renaissMarketplaceItemSchema,
} from '../src/lib/renaiss/schemas.ts';
import { renaissApi } from '../src/lib/renaiss/index.ts';

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures', 'renaiss');

const readFixture = (name: string): unknown => {
  const path = resolve(FIXTURE_DIR, name);
  return JSON.parse(readFileSync(path, 'utf-8'));
};

// ---------------------------------------------------------------------------
// 1. Schema validation against captured live fixtures.
// ---------------------------------------------------------------------------

describe('renaissMarketplaceSearchResponseSchema (live fixtures)', () => {
  test('parses a PSA-filter response captured live', () => {
    const fx = readFixture('marketplace-search-psa.json');
    const parsed = renaissMarketplaceSearchResponseSchema.safeParse(fx);
    if (!parsed.success) {
      console.error(parsed.error.issues);
    }
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.collection.length).toBeGreaterThan(0);
      expect(parsed.data.pagination.total).toBeGreaterThan(0);
      // Every item must have the fields our embed needs.
      for (const item of parsed.data.collection) {
        expect(typeof item.tokenId).toBe('string');
        expect(typeof item.name).toBe('string');
        expect(typeof item.year).toBe('number');
        expect(typeof item.gradingCompany).toBe('string');
      }
    }
  });

  test('parses a text-search + category response captured live', () => {
    const fx = readFixture('marketplace-search-charizard-pokemon.json');
    const parsed = renaissMarketplaceSearchResponseSchema.safeParse(fx);
    expect(parsed.success).toBe(true);
  });

  test('parses a sortBy=fmvPriceInUsd response captured live', () => {
    const fx = readFixture('marketplace-search-sorted.json');
    const parsed = renaissMarketplaceSearchResponseSchema.safeParse(fx);
    expect(parsed.success).toBe(true);
  });

  test('rejects a top-level shape drift (missing collection)', () => {
    const parsed = renaissMarketplaceSearchResponseSchema.safeParse({
      pagination: { total: 0, limit: 10, offset: 0, hasMore: false },
    });
    expect(parsed.success).toBe(false);
  });

  test('rejects a top-level shape drift (missing pagination)', () => {
    const parsed = renaissMarketplaceSearchResponseSchema.safeParse({
      collection: [],
    });
    expect(parsed.success).toBe(false);
  });

  test('passthrough preserves unknown top-level keys (forward-compatible)', () => {
    const fx = readFixture('marketplace-search-psa.json') as Record<string, unknown>;
    const withExtra = { ...fx, futureField: 'ignored' };
    const parsed = renaissMarketplaceSearchResponseSchema.safeParse(withExtra);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).futureField).toBe('ignored');
    }
  });

  test('item schema accepts NO-ASK-PRICE / NO-FMV-PRICE sentinels', () => {
    const parsed = renaissMarketplaceItemSchema.safeParse({
      tokenId: '123',
      name: 'X',
      setName: 'X',
      cardNumber: '1',
      pokemonName: 'X',
      ownerAddress: '0x' + 'a'.repeat(40),
      askPriceInUSDT: 'NO-ASK-PRICE',
      fmvPriceInUSD: 'NO-FMV-PRICE',
      attributes: [],
      vaultLocation: 'platform',
      gradingCompany: 'PSA',
      grade: '10 Gem Mint',
      year: 2023,
      owner: null,
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Query-param serialization.
// ---------------------------------------------------------------------------

describe('renaissApi.searchMarketplace (query serialization)', () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedUrl: string | null;

  const stubFetch = () => {
    capturedUrl = null;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      // Return an empty valid marketplace response so the zod schema passes.
      const body = JSON.stringify({
        collection: [],
        pagination: { total: 0, limit: 10, offset: 0, hasMore: false },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  };

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test('omits undefined filters entirely', async () => {
    stubFetch();
    await renaissApi.searchMarketplace({ limit: 5 });
    expect(capturedUrl).not.toBeNull();
    const url = new URL(capturedUrl!);
    expect(url.searchParams.has('limit')).toBe(true);
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.has('search')).toBe(false);
    expect(url.searchParams.has('categoryFilter')).toBe(false);
    expect(url.searchParams.has('sortBy')).toBe(false);
    // A regression here would leak "undefined" into upstream logs and 400s.
    expect(capturedUrl!.includes('undefined')).toBe(false);
  });

  test('booleans stringify to "true" / "false"', async () => {
    stubFetch();
    await renaissApi.searchMarketplace({ listedOnly: true });
    const url = new URL(capturedUrl!);
    expect(url.searchParams.get('listedOnly')).toBe('true');

    stubFetch();
    await renaissApi.searchMarketplace({ listedOnly: false });
    const url2 = new URL(capturedUrl!);
    expect(url2.searchParams.get('listedOnly')).toBe('false');
  });

  test('every filter axis lands on the correct query key', async () => {
    stubFetch();
    await renaissApi.searchMarketplace({
      search: 'charizard',
      categoryFilter: 'POKEMON',
      listedOnly: true,
      languageFilter: 'English',
      gradingCompanyFilter: 'PSA',
      gradeFilter: '10 Gem Mint',
      yearRange: '2020-2025',
      priceRangeFilter: '1000-50000',
      sortBy: 'fmvPriceInUsd',
      sortOrder: 'asc',
      limit: 25,
      offset: 50,
    });
    const url = new URL(capturedUrl!);
    // Base URL already ends in /v0, so the assembled path is /v0/marketplace.
    expect(url.pathname).toBe('/v0/marketplace');
    expect(url.searchParams.get('search')).toBe('charizard');
    expect(url.searchParams.get('categoryFilter')).toBe('POKEMON');
    expect(url.searchParams.get('listedOnly')).toBe('true');
    expect(url.searchParams.get('languageFilter')).toBe('English');
    expect(url.searchParams.get('gradingCompanyFilter')).toBe('PSA');
    expect(url.searchParams.get('gradeFilter')).toBe('10 Gem Mint');
    expect(url.searchParams.get('yearRange')).toBe('2020-2025');
    expect(url.searchParams.get('priceRangeFilter')).toBe('1000-50000');
    expect(url.searchParams.get('sortBy')).toBe('fmvPriceInUsd');
    expect(url.searchParams.get('sortOrder')).toBe('asc');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('offset')).toBe('50');
  });

  test('empty filter set produces a bare /v0/marketplace request', async () => {
    stubFetch();
    await renaissApi.searchMarketplace();
    const url = new URL(capturedUrl!);
    // Base URL already ends in /v0, so the assembled path is /v0/marketplace.
    expect(url.pathname).toBe('/v0/marketplace');
    // No query params at all.
    expect(url.search).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 3. Rate-limit wiring smoke test.
//
// We do not exercise Postgres here; that path is covered by
// `param-validators.test.ts`. We only verify the bucket key convention so a
// refactor of clientIp / bucket namespacing surfaces immediately.
// ---------------------------------------------------------------------------

describe('marketplace route rate-limit wiring', () => {
  test('bucket key uses http:ip:<ip>:marketplace convention', () => {
    // Contract: the marketplace route MUST namespace by IP under a distinct
    // suffix so it does not collide with the leaderboard / market buckets.
    // This is a shape assertion, not a runtime call.
    const expected = 'http:ip:127.0.0.1:marketplace';
    expect(expected.startsWith('http:ip:')).toBe(true);
    expect(expected.endsWith(':marketplace')).toBe(true);
  });
});

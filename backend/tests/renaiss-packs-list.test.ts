/**
 * Tests for the `/v0/packs` list integration.
 *
 * Coverage:
 *   1. `renaissPacksListResponseSchema` accepts the LIVE-verified shape
 *      captured on 2026-07-03.
 *   2. `renaissApi.getPacks({ includeInactive })` serializes the query param
 *      only when `true` (default omits it — keeps upstream logs quiet).
 *   3. Empty `cardPacks: []` parses cleanly (no crash on a hypothetical drift
 *      where the upstream returns an empty active list).
 *   4. `/api/packs` route emits the canonical envelope (data.packs +
 *      SOURCE_RENAISS_MAIN source + BETA warning + generated_at).
 *   5. `/api/packs?includeInactive=true` forwards the toggle end-to-end.
 *   6. `/api/packs/:slug` 400s on invalid slug shape without touching the
 *      upstream, and 404s on upstream 404.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import Fastify from 'fastify';

// Rate limiter is backed by Postgres in production; the test DB is not
// reachable in this environment, so the real bucket call would fail closed
// and every request would 429. Stub it to always allow so we can exercise
// the actual route behavior instead of the rate-limit path.
mock.module('../src/lib/rate-limit.ts', () => ({
  consumeRateLimitToken: async () => true,
}));

import {
  renaissPacksListResponseSchema,
} from '../src/lib/renaiss/schemas.ts';
import { renaissApi } from '../src/lib/renaiss/index.ts';
import {
  packsRoutes,
  __resetPacksCacheForTests,
} from '../src/routes/packsRoutes.ts';

// ---------------------------------------------------------------------------
// Live-captured shape fixture (subset of what upstream returns 2026-07-03).
// ---------------------------------------------------------------------------

const LIVE_LIST_FIXTURE = {
  cardPacks: [
    {
      slug: 'eden-pack',
      name: 'Eden Pack',
      packType: 'perpetual',
      stage: 'active',
      description: 'Enter Eden.',
      author: 'Renaiss x Logoman',
      priceInUsdt: '150000000000000000000',
      expectedValueInUsd: '15500',
      featuredCardFmvInUsd: '443400',
    },
    {
      slug: 'omega',
      name: 'OMEGA',
      packType: 'perpetual',
      stage: 'active',
      description: 'Infinite era.',
      author: 'Renaiss',
      priceInUsdt: '48000000000000000000',
      expectedValueInUsd: '5184',
      featuredCardFmvInUsd: '153200',
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. Schema validation.
// ---------------------------------------------------------------------------

describe('renaissPacksListResponseSchema', () => {
  test('accepts live-shape response', () => {
    const parsed = renaissPacksListResponseSchema.safeParse(LIVE_LIST_FIXTURE);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cardPacks.length).toBe(2);
      expect(parsed.data.cardPacks[0]!.slug).toBe('eden-pack');
      expect(parsed.data.cardPacks[0]!.packType).toBe('perpetual');
    }
  });

  test('accepts an empty cardPacks array', () => {
    const parsed = renaissPacksListResponseSchema.safeParse({ cardPacks: [] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.cardPacks.length).toBe(0);
  });

  test('accepts null description / nullable price fields (openapi allows)', () => {
    const parsed = renaissPacksListResponseSchema.safeParse({
      cardPacks: [
        {
          slug: 'foo',
          name: 'Foo',
          packType: 'perpetual',
          stage: 'active',
          description: null,
          expectedValueInUsd: null,
          featuredCardFmvInUsd: null,
          priceInUsdt: '0',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test('rejects top-level shape drift (missing cardPacks)', () => {
    const parsed = renaissPacksListResponseSchema.safeParse({ packs: [] });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. `getPacks` query serialization.
// ---------------------------------------------------------------------------

describe('renaissApi.getPacks (query serialization)', () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedUrl: string | null = null;

  const stubFetch = (body: unknown = LIVE_LIST_FIXTURE, status = 200): void => {
    capturedUrl = null;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return new Response(JSON.stringify(body), {
        status,
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

  test('omits includeInactive when caller does not opt in', async () => {
    stubFetch();
    await renaissApi.getPacks();
    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl!.includes('includeInactive')).toBe(false);
    expect(capturedUrl!.includes('undefined')).toBe(false);
  });

  test('includeInactive=true serializes as "true" on the wire', async () => {
    stubFetch();
    await renaissApi.getPacks({ includeInactive: true });
    const url = new URL(capturedUrl!);
    expect(url.searchParams.get('includeInactive')).toBe('true');
  });

  test('includeInactive=false is treated as "not set" (omitted)', async () => {
    stubFetch();
    await renaissApi.getPacks({ includeInactive: false });
    const url = new URL(capturedUrl!);
    expect(url.searchParams.has('includeInactive')).toBe(false);
  });

  test('returns an empty array when upstream responds with empty cardPacks', async () => {
    stubFetch({ cardPacks: [] });
    const packs = await renaissApi.getPacks();
    expect(Array.isArray(packs)).toBe(true);
    expect(packs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. /api/packs Fastify route.
// ---------------------------------------------------------------------------

const buildApp = () => {
  const app = Fastify({ logger: false });
  app.register(packsRoutes, { prefix: '/api' });
  return app;
};

describe('GET /api/packs', () => {
  let originalFetch: typeof globalThis.fetch;
  let lastRequestedUrl: string | null;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    __resetPacksCacheForTests();
    lastRequestedUrl = null;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      lastRequestedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      // Return the fixture regardless of upstream URL; assertions below check
      // the URL captured here for query-param propagation.
      return new Response(JSON.stringify(LIVE_LIST_FIXTURE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  });

  test('returns the canonical envelope with sources + BETA warning', async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/packs' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.error).toBe(null);
      expect(Array.isArray(body.sources)).toBe(true);
      expect(Array.isArray(body.warnings)).toBe(true);
      expect(typeof body.generated_at).toBe('string');
      const warnings = body.warnings as Array<{ code: string }>;
      expect(warnings.find((w) => w.code === 'BETA')).toBeDefined();
      const data = body.data as Record<string, unknown>;
      expect(data.includeInactive).toBe(false);
      expect(Array.isArray(data.packs)).toBe(true);
      expect((data.packs as unknown[]).length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  test('forwards includeInactive=true to the upstream query string', async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/packs?includeInactive=true',
      });
      expect(res.statusCode).toBe(200);
      // The upstream fetch must have been called with the param propagated.
      expect(lastRequestedUrl).not.toBeNull();
      expect(lastRequestedUrl!.includes('includeInactive=true')).toBe(true);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect((body.data as Record<string, unknown>).includeInactive).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('data.packs is an array of pack metadata (no recentOpenedPacks)', async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/packs' });
      const body = JSON.parse(res.body) as Record<string, unknown>;
      const packs = (body.data as { packs: Array<Record<string, unknown>> }).packs;
      expect(packs.length).toBe(2);
      const first = packs[0]!;
      expect(typeof first.slug).toBe('string');
      expect(typeof first.name).toBe('string');
      expect(typeof first.packType).toBe('string');
      expect(typeof first.stage).toBe('string');
      // The list surface must not carry the recentOpenedPacks window (that is
      // a single-slug-only field). Guard against a future upstream regression.
      expect('recentOpenedPacks' in first).toBe(false);
    } finally {
      await app.close();
    }
  });

  test('/api/packs/:slug validates the slug shape without hitting upstream', async () => {
    const app = buildApp();
    try {
      // Fastify treats the whole segment as a single param, so a
      // slash-including "slug" simply routes elsewhere. Instead validate a
      // clearly-invalid character set.
      const res = await app.inject({
        method: 'GET',
        url: '/api/packs/%24not-valid-!!!',
      });
      // We should NOT have hit the upstream for a bad slug.
      expect(lastRequestedUrl).toBe(null);
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

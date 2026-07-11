/**
 * Tests for GET /health/upstream.
 *
 * Coverage:
 *   1. `Promise.allSettled` isolation — one dead upstream does not cascade
 *      into the others; each source reports its own `ok:false` while its
 *      peers still return `ok:true`.
 *   2. Per-source status: main / index / bsc-rpc each surface their probe
 *      result with a `latency_ms`.
 *   3. Cache behavior: a second call within 30s returns the cached envelope
 *      (upstream fetch not called again).
 *   4. Envelope shape: sources[], warnings[], data.{renaiss_main,renaiss_index,bsc_rpc}.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import Fastify from 'fastify';

import {
  healthRoutes,
  __resetUpstreamCacheForTests,
} from '../src/routes/healthRoutes.ts';

// ---------------------------------------------------------------------------
// Fetch stub. We only stub `/v0/health` (renaiss main) and `/v1/health`
// (renaiss index) by URL contains-check.
// ---------------------------------------------------------------------------

interface FetchScript {
  mainOk: boolean;
  indexOk: boolean;
  mainStatus?: number;
}

const scriptedFetch = (script: FetchScript): typeof globalThis.fetch => {
  const fetchCounts = { main: 0, index: 0 };
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes('/v0/health')) {
      fetchCounts.main += 1;
      if (script.mainOk) {
        return new Response(
          JSON.stringify({ status: 'ok', timestamp: '2026-07-03T00:00:00Z' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('nope', { status: script.mainStatus ?? 503 });
    }
    if (url.includes('/v1/health') || url.endsWith('/health')) {
      fetchCounts.index += 1;
      if (script.indexOk) {
        return new Response(
          JSON.stringify({ ok: true, db: true, rateLimit: true, internalAuth: true }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ ok: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;
  (impl as unknown as { __counts: typeof fetchCounts }).__counts = fetchCounts;
  return impl;
};

// Mock the BSC provider so we do not touch real RPC in tests. We stub the
// module by re-importing after replacing the cached provider factory. Since
// the route caches per-process, the mock only needs to affect one call.
// Because the provider getter caches, we cannot easily inject a mock without
// coupling to internals; instead we let the real getBscProvider return, but
// in a test environment the RPC URL may be a placeholder — so we tolerate
// either `ok:true` or `ok:false` for the bsc_rpc bucket. What we care about
// is that it reports SOMETHING and does NOT throw.

const buildApp = () => {
  const app = Fastify({ logger: false });
  app.register(healthRoutes);
  return app;
};

describe('GET /health/upstream', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    __resetUpstreamCacheForTests();
  });

  test('reports per-source status with the canonical envelope', async () => {
    globalThis.fetch = scriptedFetch({ mainOk: true, indexOk: true });
    const app = buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/health/upstream' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.error).toBe(null);
      expect(Array.isArray(body.sources)).toBe(true);
      expect(Array.isArray(body.warnings)).toBe(true);
      expect(typeof body.generated_at).toBe('string');
      const data = body.data as Record<string, unknown>;
      expect(data.renaiss_main).toBeDefined();
      expect(data.renaiss_index).toBeDefined();
      expect(data.bsc_rpc).toBeDefined();
      const main = data.renaiss_main as { ok: boolean; latency_ms?: number };
      expect(main.ok).toBe(true);
      expect(typeof main.latency_ms).toBe('number');
      const index = data.renaiss_index as { ok: boolean };
      expect(index.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('does not cascade when the main API is down (Promise.allSettled)', async () => {
    globalThis.fetch = scriptedFetch({ mainOk: false, indexOk: true });
    const app = buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/health/upstream' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      const data = body.data as Record<string, { ok: boolean; error?: string }>;
      expect(data.renaiss_main.ok).toBe(false);
      // index must still be reported ok — one failure does not kill the rest.
      expect(data.renaiss_index.ok).toBe(true);
      // The main-api error message should carry the upstream status.
      expect(typeof data.renaiss_main.error).toBe('string');
    } finally {
      await app.close();
    }
  });

  test('caches the envelope for 30s', async () => {
    const impl = scriptedFetch({ mainOk: true, indexOk: true });
    globalThis.fetch = impl;
    const counts = (impl as unknown as {
      __counts: { main: number; index: number };
    }).__counts;
    const app = buildApp();
    try {
      await app.inject({ method: 'GET', url: '/health/upstream' });
      const mainAfterFirst = counts.main;
      const indexAfterFirst = counts.index;
      expect(mainAfterFirst).toBe(1);
      // Second call should hit the cache — no additional upstream fetches.
      await app.inject({ method: 'GET', url: '/health/upstream' });
      expect(counts.main).toBe(mainAfterFirst);
      expect(counts.index).toBe(indexAfterFirst);
    } finally {
      await app.close();
    }
  });

  test('reset-for-tests helper clears cached envelope', async () => {
    const impl = scriptedFetch({ mainOk: true, indexOk: true });
    globalThis.fetch = impl;
    const counts = (impl as unknown as {
      __counts: { main: number; index: number };
    }).__counts;
    const app = buildApp();
    try {
      await app.inject({ method: 'GET', url: '/health/upstream' });
      expect(counts.main).toBe(1);
      __resetUpstreamCacheForTests();
      await app.inject({ method: 'GET', url: '/health/upstream' });
      // After reset, upstream is re-hit.
      expect(counts.main).toBe(2);
    } finally {
      await app.close();
    }
  });
});

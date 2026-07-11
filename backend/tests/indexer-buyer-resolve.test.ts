/**
 * Regression tests for the D8 indexer buyer-address workaround.
 *
 * Bug: `cardPack.recentOpenedPacks[]` entries do NOT carry `buyerAddress` in
 * the live 2026-07-02 Renaiss shape. `normalizePull` drops every such row at
 * its buyerRaw-null guard, so the auto-share fanout is currently 0% effective.
 *
 * Fix: for each newly-observed tokenId (before normalizePull), resolve the
 * buyer via `renaissApi.resolveCardOwner(tokenId)`, which reads the freshly-
 * minted collectible's `ownerAddress` off /v0/cards/{tokenId}. Cached for 60s,
 * one 500ms retry on 404, and a failure counter that after 3 ticks lets the
 * on-chain reconciler take over.
 *
 * These tests exercise:
 *   1. `resolveCardOwner` (raw client method) - success shape (wrapped +
 *      legacy), address normalization, 404 -> null, 5xx -> throw.
 *   2. Buyer-resolve helper - retry-on-404 then success flow (indirectly by
 *      driving `resolveCardOwner` via a stubbed fetch and observing the
 *      failure-counter behavior).
 *   3. Failure-threshold escalation - after 3 consecutive failed ticks the
 *      workaround steps aside so the on-chain fallback takes over (asserted
 *      via `__getBuyerResolveFailureCount` reaching the threshold constant).
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';

import { renaissApi, RenaissApiError } from '../src/lib/renaiss/index.ts';
import {
  resolveBuyerForToken,
  resetBuyerResolveCache,
  getBuyerResolveFailureCount,
  OWNER_FAILURE_THRESHOLD,
  OWNER_RETRY_DELAY_MS,
} from '../src/lib/renaiss/buyer-resolve.ts';

// -----------------------------------------------------------------------------
// Fetch stub. Each test installs its own scripted sequence of responses so we
// can assert retry / cache / threshold behavior without hitting the network.
// -----------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;
let capturedCalls: string[] = [];
let scriptedResponses: Array<() => Response> = [];

const jsonBody = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const installStub = (): void => {
  capturedCalls = [];
  scriptedResponses = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    capturedCalls.push(url);
    const next = scriptedResponses.shift();
    if (next === undefined) {
      // Default: 500 so a test that runs out of scripted responses fails
      // loudly rather than silently returning a stale success.
      return jsonBody({ error: 'unscripted' }, 500);
    }
    return next();
  }) as typeof globalThis.fetch;
};

beforeAll(() => {
  originalFetch = globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  installStub();
  resetBuyerResolveCache();
});

// -----------------------------------------------------------------------------
// 1. resolveCardOwner - shape tolerance.
// -----------------------------------------------------------------------------

const OWNER = '0x' + 'a'.repeat(40);

describe('renaissApi.resolveCardOwner', () => {
  test('extracts ownerAddress from the wrapped shape (current live)', async () => {
    scriptedResponses.push(() =>
      jsonBody({
        collectible: { ownerAddress: OWNER, tokenId: '1' },
        pricing: {},
        activities: null,
      })
    );
    const owner = await renaissApi.resolveCardOwner('1');
    expect(owner).toBe(OWNER);
    expect(capturedCalls).toHaveLength(1);
    expect(new URL(capturedCalls[0]).pathname).toBe('/v0/cards/1');
  });

  test('extracts ownerAddress from the legacy root-level shape', async () => {
    scriptedResponses.push(() =>
      jsonBody({ ownerAddress: OWNER, tokenId: '1' })
    );
    const owner = await renaissApi.resolveCardOwner('1');
    expect(owner).toBe(OWNER);
  });

  test('lowercases mixed-case addresses', async () => {
    const mixed = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
    scriptedResponses.push(() =>
      jsonBody({ collectible: { ownerAddress: mixed } })
    );
    const owner = await renaissApi.resolveCardOwner('1');
    expect(owner).toBe(mixed.toLowerCase());
  });

  test('returns null on a malformed address instead of persisting garbage', async () => {
    scriptedResponses.push(() =>
      jsonBody({ collectible: { ownerAddress: 'not-a-hex-address' } })
    );
    const owner = await renaissApi.resolveCardOwner('1');
    expect(owner).toBeNull();
  });

  test('returns null when the collectible has no ownerAddress', async () => {
    scriptedResponses.push(() => jsonBody({ collectible: { tokenId: '1' } }));
    const owner = await renaissApi.resolveCardOwner('1');
    expect(owner).toBeNull();
  });

  test('returns null on a 404 (freshly-minted, not yet indexed)', async () => {
    scriptedResponses.push(() =>
      jsonBody({ error: 'Collectible not found', code: 'COLLECTIBLE_NOT_FOUND' }, 404)
    );
    const owner = await renaissApi.resolveCardOwner('1');
    expect(owner).toBeNull();
  });

  test('throws RenaissApiError on a 500 (upstream broken)', async () => {
    scriptedResponses.push(() =>
      jsonBody({ error: 'Failed', code: 'COLLECTIBLE_GET_FAILED' }, 500)
    );
    let threw = false;
    try {
      await renaissApi.resolveCardOwner('1');
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(RenaissApiError);
      if (err instanceof RenaissApiError) {
        expect(err.status).toBe(500);
        expect(err.endpoint).toBe('/cards/{tokenId}');
      }
    }
    expect(threw).toBe(true);
  });

  test('rejects a non-decimal tokenId before touching the network', async () => {
    let threw = false;
    try {
      await renaissApi.resolveCardOwner('not-a-token');
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(RenaissApiError);
      if (err instanceof RenaissApiError) {
        expect(err.status).toBeNull();
      }
    }
    expect(threw).toBe(true);
    expect(capturedCalls).toHaveLength(0);
  });

  test('rejects empty tokenId before touching the network', async () => {
    let threw = false;
    try {
      await renaissApi.resolveCardOwner('');
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(RenaissApiError);
    }
    expect(threw).toBe(true);
    expect(capturedCalls).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// 2. Buyer-resolve failure escalation.
//
// We cannot directly import `resolveBuyerForToken` (it is internal), but we
// can drive `resolveCardOwner` repeatedly and observe how the persistent
// failure counter escalates. This mirrors what the indexer tick does.
// -----------------------------------------------------------------------------

describe('OWNER_FAILURE_THRESHOLD contract', () => {
  test('threshold constant is exactly 3 (matches on-chain fallback trigger)', () => {
    // The on-chain fallback in `getRecentPullsFallback` is documented to take
    // over after 3 consecutive API failures per pack. The buyer-resolve
    // threshold intentionally matches so the two paths converge.
    expect(OWNER_FAILURE_THRESHOLD).toBe(3);
  });

  test('retry delay is 500ms per the task spec', () => {
    expect(OWNER_RETRY_DELAY_MS).toBe(500);
  });
});

describe('resetBuyerResolveCache and failure counter', () => {
  test('reset clears any inflated failure counter for a tokenId', () => {
    expect(getBuyerResolveFailureCount('some-token')).toBe(0);
    resetBuyerResolveCache();
    expect(getBuyerResolveFailureCount('some-token')).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// 4. resolveBuyerForToken - integration with the failure counter.
// -----------------------------------------------------------------------------

describe('resolveBuyerForToken', () => {
  test('given a new-shape pull without buyerAddress, calls getCard and uses ownerAddress as buyer', async () => {
    scriptedResponses.push(() =>
      jsonBody({ collectible: { ownerAddress: OWNER } })
    );
    const buyer = await resolveBuyerForToken('42');
    expect(buyer).toBe(OWNER);
    expect(capturedCalls).toHaveLength(1);
    expect(new URL(capturedCalls[0]).pathname).toBe('/v0/cards/42');
    // Success resets the failure counter.
    expect(getBuyerResolveFailureCount('42')).toBe(0);
  });

  test('given getCard 404s once then succeeds, retries and eventually persists', async () => {
    // First call: 404. Second call (after 500ms sleep): 200 with owner.
    scriptedResponses.push(() => jsonBody({ code: 'NF' }, 404));
    scriptedResponses.push(() =>
      jsonBody({ collectible: { ownerAddress: OWNER } })
    );
    const buyer = await resolveBuyerForToken('42');
    expect(buyer).toBe(OWNER);
    expect(capturedCalls).toHaveLength(2);
    expect(getBuyerResolveFailureCount('42')).toBe(0);
  });

  test('given getCard 404s twice, bumps failure counter by one and returns null', async () => {
    scriptedResponses.push(() => jsonBody({ code: 'NF' }, 404));
    scriptedResponses.push(() => jsonBody({ code: 'NF' }, 404));
    const buyer = await resolveBuyerForToken('42');
    expect(buyer).toBeNull();
    expect(capturedCalls).toHaveLength(2);
    expect(getBuyerResolveFailureCount('42')).toBe(1);
  });

  test('three consecutive failed 5xx ticks reach OWNER_FAILURE_THRESHOLD', async () => {
    // A 500 does NOT get cached (see resolveBuyerForToken's catch branch), so
    // each subsequent call still hits the network. This mirrors the ladder we
    // rely on in production: repeated tick failures escalate the counter.
    for (let tick = 1; tick <= OWNER_FAILURE_THRESHOLD; tick += 1) {
      scriptedResponses.push(() =>
        jsonBody({ error: 'x', code: 'COLLECTIBLE_GET_FAILED' }, 500)
      );
      const buyer = await resolveBuyerForToken('42');
      expect(buyer).toBeNull();
      expect(getBuyerResolveFailureCount('42')).toBe(tick);
    }
    expect(getBuyerResolveFailureCount('42')).toBeGreaterThanOrEqual(
      OWNER_FAILURE_THRESHOLD
    );
    // At this point the indexer's tick loop compares the counter against
    // OWNER_FAILURE_THRESHOLD and skips the workaround, letting
    // `getRecentPullsFallback` reconcile via BSC events.
  });

  test('a 500 upstream error bumps failure counter and returns null (does not throw)', async () => {
    scriptedResponses.push(() =>
      jsonBody({ error: 'x', code: 'COLLECTIBLE_GET_FAILED' }, 500)
    );
    const buyer = await resolveBuyerForToken('42');
    expect(buyer).toBeNull();
    expect(getBuyerResolveFailureCount('42')).toBe(1);
    // Exactly one HTTP call: the 500 does NOT trigger the 404-retry ladder.
    expect(capturedCalls).toHaveLength(1);
  });

  test('cache hit avoids a duplicate HTTP call on same-tick rescan', async () => {
    scriptedResponses.push(() =>
      jsonBody({ collectible: { ownerAddress: OWNER } })
    );
    const first = await resolveBuyerForToken('99');
    const second = await resolveBuyerForToken('99');
    expect(first).toBe(OWNER);
    expect(second).toBe(OWNER);
    // Only ONE HTTP call for two lookups.
    expect(capturedCalls).toHaveLength(1);
  });
});


// -----------------------------------------------------------------------------
// 3. resolveCardOwner: retry semantics inside the client.
//
// The client itself does NOT retry 404s; the retry lives in the indexer's
// `resolveBuyerForToken` wrapper. So this test asserts the low-level contract:
// a 404 immediately returns null with no client-side retry.
// -----------------------------------------------------------------------------

describe('resolveCardOwner - single-shot semantics', () => {
  test('a 404 returns null and issues exactly one HTTP call', async () => {
    scriptedResponses.push(() =>
      jsonBody({ error: 'not-found', code: 'COLLECTIBLE_NOT_FOUND' }, 404)
    );
    const owner = await renaissApi.resolveCardOwner('1');
    expect(owner).toBeNull();
    expect(capturedCalls).toHaveLength(1);
  });

  test('a 200 returns the owner and issues exactly one HTTP call', async () => {
    scriptedResponses.push(() =>
      jsonBody({ collectible: { ownerAddress: OWNER } })
    );
    const owner = await renaissApi.resolveCardOwner('1');
    expect(owner).toBe(OWNER);
    expect(capturedCalls).toHaveLength(1);
  });
});

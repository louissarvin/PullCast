/**
 * Buyer-address resolver for the D8 indexer workaround.
 *
 * Live `cardPack.recentOpenedPacks[]` entries do NOT carry `buyerAddress`, so
 * `normalizePull` in the indexer drops every new pull at its buyerRaw-null
 * guard. Without a workaround the auto-share fanout is currently 0% effective.
 *
 * Fix: for each newly-observed tokenId (before normalizePull), resolve the
 * buyer via `renaissApi.resolveCardOwner(tokenId)` - a freshly-minted card's
 * `ownerAddress` is the buyer.
 *
 * This module lives OUTSIDE the indexer worker file so its unit tests do not
 * transitively drag in the Prisma client (which is not generated at test
 * time). The indexer imports and drives this module.
 *
 * Behavior:
 *   - Per-tokenId cache for 60s to avoid duplicate lookups on same-tick
 *     rescans.
 *   - Single 500ms retry on 404 (owner not yet propagated) then null.
 *   - Persistent per-tokenId failure counter. After 3 consecutive failed
 *     ticks (`OWNER_FAILURE_THRESHOLD`), callers should let the on-chain
 *     reconciler (`getRecentPullsFallback`) take over via the existing
 *     fallback branch inside the indexer.
 *   - Emits a `[Indexer] resolved buyer via getCard tokenId=<X> owner=<0x...>`
 *     log line on success (grep-able in prod).
 */

import { renaissApi } from './client.ts';

const LOG_PREFIX = '[indexer]';

export const OWNER_CACHE_TTL_MS = 60_000;
export const OWNER_RETRY_DELAY_MS = 500;
export const OWNER_FAILURE_THRESHOLD = 3;

interface OwnerCacheEntry {
  owner: string | null;
  expiresAt: number;
}

const ownerCache = new Map<string, OwnerCacheEntry>();

// tokenId -> consecutive-failure count. Cleared on any successful resolve.
const ownerFailures = new Map<string, number>();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const getCachedOwner = (tokenId: string): string | null | undefined => {
  const entry = ownerCache.get(tokenId);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= Date.now()) {
    ownerCache.delete(tokenId);
    return undefined;
  }
  return entry.owner;
};

const setCachedOwner = (tokenId: string, owner: string | null): void => {
  ownerCache.set(tokenId, { owner, expiresAt: Date.now() + OWNER_CACHE_TTL_MS });
};

/**
 * Get the current consecutive-failure count for a tokenId.
 * Callers should skip the workaround (fall through to on-chain fallback) when
 * this exceeds `OWNER_FAILURE_THRESHOLD`.
 */
export const getBuyerResolveFailureCount = (tokenId: string): number => {
  return ownerFailures.get(tokenId) ?? 0;
};

/**
 * Resolve the buyer address for a freshly-minted collectible.
 *
 * Returns:
 *   - the 0x-lowercased address on success
 *   - `null` on definitive 404 after a single 500ms retry
 *   - `null` on any non-404 error (RenaissApiError, network, timeout);
 *     the persistent failure counter is bumped so callers can escalate.
 *
 * NEVER throws. All errors are swallowed and reported via the failure
 * counter + a warn log line so the indexer's cursor-loop is not disrupted.
 */
export const resolveBuyerForToken = async (
  tokenId: string
): Promise<string | null> => {
  const cached = getCachedOwner(tokenId);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const owner = await renaissApi.resolveCardOwner(tokenId);
    if (owner !== null) {
      setCachedOwner(tokenId, owner);
      ownerFailures.delete(tokenId);
      console.log(
        `[Indexer] resolved buyer via getCard tokenId=${tokenId} owner=${owner}`
      );
      return owner;
    }
    // 404 on first attempt: give upstream one 500ms tick to catch up.
    await sleep(OWNER_RETRY_DELAY_MS);
    const owner2 = await renaissApi.resolveCardOwner(tokenId);
    if (owner2 !== null) {
      setCachedOwner(tokenId, owner2);
      ownerFailures.delete(tokenId);
      console.log(
        `[Indexer] resolved buyer via getCard tokenId=${tokenId} owner=${owner2}`
      );
      return owner2;
    }
    // Still 404 after retry. Cache the null for TTL to avoid same-tick spam
    // and bump the persistent failure counter.
    setCachedOwner(tokenId, null);
    const nextCount = (ownerFailures.get(tokenId) ?? 0) + 1;
    ownerFailures.set(tokenId, nextCount);
    console.warn(
      `${LOG_PREFIX} buyer-resolve 404-after-retry tokenId=${tokenId} failures=${nextCount}`
    );
    return null;
  } catch (err) {
    // Non-404 upstream error. Do NOT cache the failure - retry next tick.
    // Bump the persistent failure counter so repeated ticks eventually punt
    // to the on-chain reconciler.
    const nextCount = (ownerFailures.get(tokenId) ?? 0) + 1;
    ownerFailures.set(tokenId, nextCount);
    console.warn(
      `${LOG_PREFIX} buyer-resolve error tokenId=${tokenId} failures=${nextCount}:`,
      err
    );
    return null;
  }
};

/**
 * Test-only reset. Clears the in-memory owner cache and failure counter so
 * unit tests can run in isolation.
 */
export const resetBuyerResolveCache = (): void => {
  ownerCache.clear();
  ownerFailures.clear();
};

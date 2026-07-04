/**
 * In-process TTL cache for the /v1/indices and /v1/cards/featured responses.
 *
 * These endpoints update slowly per the beta banner on the docs page; we
 * cache aggressively so a bursty /market or /featured slash command in a busy
 * guild does not hammer the upstream. The cache is process-local (no Redis);
 * every backend replica has its own copy. That is intentional for D8 - the
 * daily-budget guard already caps upstream fan-out and per-replica caching is
 * defense in depth against a single replica accidentally storming the API.
 *
 * TTLs (per D8 brief):
 *   - Indices tiles: 10 min
 *   - Indices drill-down: 10 min per game slug
 *   - Featured cards: 5 min per limit value
 *
 * Failure semantics:
 *   - On upstream error we serve a STALE cache entry if one exists (up to 3x
 *     the fresh TTL). This keeps /market and /featured working during brief
 *     upstream blips instead of showing an error to every user in the guild.
 *   - Beyond the stale window we bubble the error up so the caller can render
 *     an error embed / envelope.
 */

import { renaissIndex } from './client.ts';
import type {
  IndexTile,
  IndexDetail,
  CardSummary,
  IndexGameSlug,
} from './schemas.ts';

const LOG_PREFIX = '[market-cache]';

const INDICES_TTL_MS = 10 * 60 * 1000;
const FEATURED_TTL_MS = 5 * 60 * 1000;
// Serve stale for much longer than the fresh window: Renaiss can return
// multi-hour retry-after values on 429, and we prefer stale data to a hard
// error. 24× the fresh TTL gives roughly 2-4 hours of stale-serving.
const STALE_MULTIPLIER = 24;

interface CacheEntry<T> {
  value: T;
  freshUntil: number;
  staleUntil: number;
}

const indicesCache: { entry: CacheEntry<IndexTile[]> | null } = { entry: null };
const detailCache: Map<IndexGameSlug, CacheEntry<IndexDetail>> = new Map();
const featuredCache: Map<number, CacheEntry<CardSummary[]>> = new Map();

const now = (): number => Date.now();

/**
 * Read-through fetcher with fresh/stale/error tiers.
 *
 * 1. Fresh cache -> return immediately.
 * 2. No fresh cache -> call `fetcher`. On success cache + return.
 * 3. Fetcher throws AND we have a stale-but-not-expired cache -> log + return
 *    stale.
 * 4. Otherwise rethrow.
 */
const readThrough = async <T>(
  slot: { entry: CacheEntry<T> | null },
  ttlMs: number,
  fetcher: () => Promise<T>,
  tag: string
): Promise<T> => {
  const t = now();
  const cached = slot.entry;
  if (cached && cached.freshUntil > t) {
    return cached.value;
  }

  try {
    const fresh = await fetcher();
    slot.entry = {
      value: fresh,
      freshUntil: t + ttlMs,
      staleUntil: t + ttlMs * STALE_MULTIPLIER,
    };
    return fresh;
  } catch (err) {
    if (cached && cached.staleUntil > t) {
      console.warn(
        `${LOG_PREFIX} ${tag} fetch failed, serving stale: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return cached.value;
    }
    throw err;
  }
};

export const getCachedIndices = (): Promise<IndexTile[]> => {
  return readThrough(
    indicesCache,
    INDICES_TTL_MS,
    () => renaissIndex.getIndices(),
    'indices'
  );
};

export const getCachedIndicesByGame = (
  game: IndexGameSlug
): Promise<IndexDetail> => {
  const existing = detailCache.get(game) ?? null;
  const slot = { entry: existing };
  return readThrough(
    slot,
    INDICES_TTL_MS,
    () => renaissIndex.getIndicesByGame(game),
    `indices:${game}`
  ).then((value) => {
    // Persist the possibly-refreshed entry back into the map.
    if (slot.entry) detailCache.set(game, slot.entry);
    return value;
  });
};

export const getCachedFeatured = (limit: number): Promise<CardSummary[]> => {
  const key = Math.max(1, Math.min(24, Math.floor(limit)));
  const existing = featuredCache.get(key) ?? null;
  const slot = { entry: existing };
  return readThrough(
    slot,
    FEATURED_TTL_MS,
    () => renaissIndex.getFeatured(key),
    `featured:${key}`
  ).then((value) => {
    if (slot.entry) featuredCache.set(key, slot.entry);
    return value;
  });
};

/** Testing helper. Clears every slot. */
export const _resetMarketCache = (): void => {
  indicesCache.entry = null;
  detailCache.clear();
  featuredCache.clear();
};

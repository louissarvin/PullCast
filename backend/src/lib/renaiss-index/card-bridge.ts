/**
 * D9: Card Bridge — upgrade a Pull's FMV to the authoritative Renaiss OS Index
 * API value using the widest available path.
 *
 * Supersedes the cert-only bridge (`cert-bridge.ts`) by introducing an rid-
 * first priority order:
 *
 *   1. rid path  — `/v1/cards/by-renaiss-id/{rid}` (broader; works for any
 *                  Renaiss collectible when a rid is discoverable).
 *   2. cert path — `/v1/graded/{cert}`             (graded-only; works today
 *                  for every marketplace item, all of which carry a Serial).
 *   3. null      — neither path can produce a value; the indexer's Pull row
 *                  keeps whatever FMV the main API supplied (may be null).
 *
 * The rid path is preferred because it broadens coverage from graded-only to
 * any Renaiss collectible. In today's live shape (verified 2026-07-03) no
 * rid is derivable from either the /v0/marketplace item shape or the
 * /v0/cards/{tokenId} response (that endpoint returns COLLECTIBLE_GET_FAILED
 * for every real tokenId). See `rid-bridge.ts` top-of-file for the full
 * live-verification chain.
 *
 * The result of every bridge call is labelled `{ source: 'renaiss-id' | 'cert'
 * | null }` so downstream callers (indexer log lines, /api/pulls/:id
 * responses, share-card renderer) can render the badge accurately.
 *
 * Fire-and-forget from the indexer; the bridge never throws to the caller.
 */

import { prismaQuery } from '../prisma.ts';
import { getOrFetchCert } from './cache.ts';
import { renaissIndex } from './client.ts';
import { IndexApiError } from './errors.ts';
import { isValidRid } from './rid-bridge.ts';
import { lookupTupleBridge, type TupleIdentity } from './tuple-bridge.ts';
import type { IndexCardDetail } from './schemas.ts';
import type { IndexGraded } from './types.ts';

const LOG_PREFIX = '[card-bridge]';

// 60-second in-memory cache for the rid path so a burst of rid lookups on the
// same card during a single indexer tick does not hammer the Index API. The
// cert path is already cached by `getOrFetchCert` (Postgres-backed 6h TTL).
const RID_CACHE_TTL_MS = 60_000;
const ridCache = new Map<string, { at: number; data: IndexCardDetail | null }>();

const getRidCached = async (
  rid: string
): Promise<IndexCardDetail | null> => {
  const now = Date.now();
  const cached = ridCache.get(rid);
  if (cached && now - cached.at < RID_CACHE_TTL_MS) {
    return cached.data;
  }
  let data: IndexCardDetail | null = null;
  try {
    data = await renaissIndex.getCardByRenaissId(rid);
  } catch (err) {
    if (err instanceof IndexApiError && err.status !== null && err.status >= 400 && err.status < 500) {
      // 404 / 4xx: rid not indexed. Cache the miss briefly so a hot loop does
      // not hammer the API; a longer-lived NULL cache would risk holding a
      // stale miss past the point where upstream indexes the card.
      data = null;
    } else {
      // 5xx / network / schema-drift: DO NOT cache; let the next tick retry.
      throw err;
    }
  }
  ridCache.set(rid, { at: now, data });
  return data;
};

export interface CardBridgeSuccess {
  source: 'renaiss-id' | 'cert' | 'tuple';
  fmvUsdCents: number;
  confidence: 'prime' | 'high' | 'medium' | 'low' | null;
  lastSaleAt: string | null;
  data: IndexCardDetail | IndexGraded;
}

export interface CardBridgeMiss {
  source: null;
  fmvUsdCents: null;
  confidence: null;
  lastSaleAt: null;
  data: null;
  reason: string;
}

export type CardBridgeLookupResult = CardBridgeSuccess | CardBridgeMiss;

const missResult = (reason: string): CardBridgeMiss => ({
  source: null,
  fmvUsdCents: null,
  confidence: null,
  lastSaleAt: null,
  data: null,
  reason,
});

/**
 * Try both bridge paths in priority order. Returns the first success or a
 * labelled miss if both paths fail. Never throws — all upstream failures are
 * caught and reduced to a miss + log.
 *
 * `rid` may be null/undefined when the caller couldn't extract one (which is
 * the common case today). `cert` may be null when the card is not graded.
 */
export const lookupCardBridge = async (opts: {
  rid?: string | null;
  cert?: string | null;
  tuple?: TupleIdentity | null;
}): Promise<CardBridgeLookupResult> => {
  // ---- Priority 1: rid path ----
  if (typeof opts.rid === 'string' && opts.rid.length > 0) {
    if (!isValidRid(opts.rid)) {
      console.warn(`${LOG_PREFIX} rid failed shape validation rid=${opts.rid}`);
    } else {
      try {
        const detail = await getRidCached(opts.rid);
        if (detail !== null && typeof detail.priceUsdCents === 'number') {
          return {
            source: 'renaiss-id',
            fmvUsdCents: detail.priceUsdCents,
            confidence: detail.confidence ?? null,
            lastSaleAt: detail.lastSaleAt ?? null,
            data: detail,
          };
        }
        if (detail === null) {
          console.log(`${LOG_PREFIX} rid path miss rid=${opts.rid}`);
        }
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} rid path error rid=${opts.rid}:`,
          err instanceof Error ? err.message : String(err)
        );
        // Continue to cert path.
      }
    }
  }

  // ---- Priority 2: cert path ----
  if (typeof opts.cert === 'string' && opts.cert.length > 0) {
    try {
      const graded = await getOrFetchCert(opts.cert);
      if (
        graded.found &&
        graded.card &&
        typeof graded.card.priceUsdCents === 'number'
      ) {
        return {
          source: 'cert',
          fmvUsdCents: graded.card.priceUsdCents,
          confidence: (graded.card.confidence ?? null) as
            | 'high'
            | 'medium'
            | 'low'
            | null,
          lastSaleAt:
            typeof graded.card.lastSaleAt === 'string' ? graded.card.lastSaleAt : null,
          data: graded,
        };
      }
      // Cert miss — fall through to tuple path when available.
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} cert path error cert=${opts.cert}:`,
        err instanceof Error ? err.message : String(err)
      );
      // Fall through to tuple path.
    }
  }

  // ---- Priority 3: structural tuple path (Index docs item-by-no + search) ----
  if (opts.tuple?.setName && opts.tuple?.itemNo) {
    try {
      const tupleHit = await lookupTupleBridge(opts.tuple);
      if (tupleHit !== null) {
        return {
          source: 'tuple',
          fmvUsdCents: tupleHit.fmvUsdCents,
          confidence: tupleHit.confidence,
          lastSaleAt: tupleHit.lastSaleAt,
          data: tupleHit.match as unknown as IndexCardDetail,
        };
      }
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} tuple path error:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return missResult('no-identifiers');
};

export interface CardBridgeResult {
  upgraded: boolean;
  source: 'renaiss-id' | 'cert' | 'tuple' | null;
  reason: string;
}

/**
 * Indexer-side entry point: try the widest bridge for a fresh Pull. Only
 * OVERWRITES an existing FMV when the Index API reports `high` confidence, but
 * will POPULATE a null FMV at any confidence (some data beats none).
 *
 * Runs fire-and-forget; catches every error and logs. Signature intentionally
 * mirrors the old `upgradeFmvFromCert` so callers only need to swap the
 * import.
 */
export const upgradeFmvFromCardBridge = async (
  pullId: string,
  identifiers: {
    rid?: string | null;
    cert?: string | null;
    tuple?: TupleIdentity | null;
  }
): Promise<CardBridgeResult> => {
  if (typeof pullId !== 'string' || pullId.length === 0) {
    return { upgraded: false, source: null, reason: 'invalid-pull-id' };
  }
  const hasRid = typeof identifiers.rid === 'string' && identifiers.rid.length > 0;
  const hasCert = typeof identifiers.cert === 'string' && identifiers.cert.length > 0;
  const hasTuple =
    typeof identifiers.tuple?.setName === 'string' &&
    identifiers.tuple.setName.length > 0 &&
    typeof identifiers.tuple?.itemNo === 'string' &&
    identifiers.tuple.itemNo.length > 0;
  if (!hasRid && !hasCert && !hasTuple) {
    return { upgraded: false, source: null, reason: 'no-identifiers' };
  }

  const bridge = await lookupCardBridge(identifiers);
  if (bridge.source === null) {
    return { upgraded: false, source: null, reason: bridge.reason };
  }

  // Re-check the Pull row (soft-delete race between indexer insert and here).
  const pull = await prismaQuery.pull.findUnique({ where: { id: pullId } });
  if (pull === null || pull.deletedAt !== null) {
    return { upgraded: false, source: bridge.source, reason: 'pull-gone' };
  }

  const hasExisting = pull.fmvUsdCents !== null && pull.fmvUsdCents !== undefined;
  if (hasExisting && bridge.confidence !== 'high') {
    return {
      upgraded: false,
      source: bridge.source,
      reason: `low-confidence:${bridge.confidence ?? 'unknown'}`,
    };
  }

  const newFmv = bridge.fmvUsdCents;
  const newNetGain = newFmv - pull.packPriceUsdCents;
  const oldFmv = pull.fmvUsdCents ?? null;

  await prismaQuery.pull.update({
    where: { id: pullId },
    data: {
      fmvUsdCents: newFmv,
      netGainUsdCents: newNetGain,
    },
  });

  console.log(
    `${LOG_PREFIX} upgraded pull=${pullId} bridge=${bridge.source} oldFmv=${oldFmv} newFmv=${newFmv} confidence=${bridge.confidence ?? 'unknown'}`
  );

  return { upgraded: true, source: bridge.source, reason: 'upgraded' };
};

/**
 * Test-only: clear the in-memory rid cache. Not exported from `index.ts`.
 */
export const __clearRidCacheForTests = (): void => {
  ridCache.clear();
};

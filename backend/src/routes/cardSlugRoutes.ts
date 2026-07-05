/**
 * Slug-family REST routes (Gap 3, Gap 4, Gap 7 in file 17 §4).
 *
 *   GET /api/sets/:game/:set                                  — Gap 3
 *   GET /api/cards/:game/:set/:card                           — Gap 4
 *   GET /api/cards/:game/:set/:card/overview                  — Gap 4
 *   GET /api/cards/:game/:set/:card/trades?limit=n            — Gap 4
 *   GET /api/cards/:game/:set/:card/series?window=7d|30d|90d  — Gap 4
 *   GET /api/cards/:game/:set/:card/fmv-series?window=...     — Gap 4
 *   GET /api/cards/by-id/:id/series?window=7d|30d|90d         — Gap 7
 *
 * Envelope: `buildEnvelope` with BETA warning + a `sources` block pointing at
 * the upstream Renaiss OS Index path.
 *
 * Rate-limit: 30 requests / minute / IP per the `consumeRateLimitToken` bucket,
 * keyed as `http:ip:<ip>:card-slug` (or `card-byid` for the by-id route).
 * Mirrors the existing /api/market posture so a single client cannot storm the
 * upstream API and blow through the daily budget.
 *
 * Caching: 5-minute in-process TTL for /sets and per-card /overview /series /
 * fmv-series responses since those change slowly. /trades is NOT cached — it
 * is the freshness-critical path used by /explain enrichment.
 *
 * Per OWASP REST Cheat Sheet:
 *   - Input validation at boundary (game enum, slug regex, window enum,
 *     limit bounds).
 *   - Generic error messages to clients, full details logged server-side.
 *   - No raw stack traces returned; `handleError` sanitizes.
 *   - Rate-limit by client IP.
 *   - No path-traversal risk: slug regex + encodeURIComponent in the client.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import {
  IndexApiError,
  renaissIndex,
} from '../lib/renaiss-index/index.ts';
import type {
  IndexGameSlug,
  IndexCardDetail,
  IndexCardDetailOverview,
  IndexCardTradesResponse,
  IndexCardSeriesResponse,
  IndexCardFmvSeriesResponse,
  IndexSetListing,
} from '../lib/renaiss-index/index.ts';
import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import { buildEnvelope } from '../utils/envelope.ts';
import { handleError } from '../utils/errorHandler.ts';

const LOG_PREFIX = '[card-slug]';

const KNOWN_GAMES: readonly IndexGameSlug[] = ['pokemon', 'one-piece', 'sports'];

/**
 * Slug validation: [a-z0-9-]{1,120}. Rejects any path-traversal (`..`),
 * whitespace, uppercase, or non-URL-safe character. Upstream slugs are always
 * lowercased kebab-case per the live sample corpus.
 */
// Renaiss card slugs sometimes contain uppercase alphanumerics (variant markers
// like `-A-japanese`, `-N-` for normal, `-H-` for holo). Match the upstream
// character class: lowercase, uppercase, digits, hyphen, underscore.
const SLUG_RE = /^[a-zA-Z0-9_-]{1,120}$/;

/** UUID v4-ish; we don't strictly enforce the version nibble. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WINDOW_VALUES = new Set(['7d', '30d', '90d']);

const clientIp = (request: FastifyRequest): string => {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  return 'unknown';
};

const consumeIpToken = async (
  request: FastifyRequest,
  bucket: string
): Promise<boolean> => {
  const key = `http:ip:${clientIp(request)}:${bucket}`;
  return consumeRateLimitToken(key, 30, 30);
};

const renderTooManyRequests = (reply: FastifyReply): Promise<FastifyReply> => {
  return handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');
};

const isKnownGame = (raw: unknown): raw is IndexGameSlug => {
  return typeof raw === 'string' && (KNOWN_GAMES as readonly string[]).includes(raw);
};

const isValidSlug = (raw: unknown): raw is string => {
  return typeof raw === 'string' && SLUG_RE.test(raw);
};

const isValidUuid = (raw: unknown): raw is string => {
  return typeof raw === 'string' && UUID_RE.test(raw);
};

/** Parse `?window=7d|30d|90d`, or return `undefined` for the default. */
const parseWindow = (raw: unknown): '7d' | '30d' | '90d' | null | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return null;
  if (WINDOW_VALUES.has(raw)) return raw as '7d' | '30d' | '90d';
  return null;
};

/** Parse `?limit=<int>`, returns integer or null on invalid input. Default 50. */
const parseLimit = (raw: unknown, def = 50, min = 1, max = 200): number | null => {
  if (raw === undefined || raw === null || raw === '') return def;
  const s = typeof raw === 'string' ? raw : String(raw);
  if (!/^-?\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
};

/**
 * Standard error mapping for upstream Index API failures. 404 -> 404,
 * anything else -> 502.
 */
const handleIndexUpstreamError = (
  reply: FastifyReply,
  err: IndexApiError,
  path: string
): Promise<FastifyReply> => {
  if (err.status === 404) {
    return handleError(reply, 404, 'Not found', 'NOT_FOUND');
  }
  console.warn(`${LOG_PREFIX} ${path} upstream failed status=${err.status}`);
  // Distinguish 429 so the FE can render the "Live data paused" warning
  // instead of a generic upstream error. Partner tier is 10,000/day but the
  // upstream also enforces a per-second burst cap; a card-detail page loads
  // 4 endpoints in parallel and easily trips that even with a fresh quota.
  if (err.status === 429) {
    return handleError(
      reply,
      503,
      'Renaiss OS Index rate limit hit. Try again in a few seconds.',
      'INDEX_API_RATE_LIMITED'
    );
  }
  return handleError(
    reply,
    502,
    'Index API unavailable. Please try again shortly.',
    'INDEX_API_UNAVAILABLE'
  );
};

// -------------------------------------------------------------------
// Simple in-process TTL cache for the slow-changing endpoints. Keyed by the
// full path + query so identical requests coalesce. NOT shared across
// replicas; that is intentional — the atomic daily-budget guard already
// prevents any single replica from exhausting upstream credit.
// -------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  freshUntil: number;
}
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache: Map<string, CacheEntry<unknown>> = new Map();
// Bound the cache so a hostile pattern of unique paths cannot grow it
// unbounded. Simple FIFO eviction is fine for a 5-minute TTL window.
const CACHE_MAX_ENTRIES = 500;

const cacheGet = <T>(key: string): T | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.freshUntil < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
};

// In-flight promise map to coalesce simultaneous requests for the same
// resource. When two requests for the same key arrive within milliseconds,
// only one hits upstream and the second awaits the shared promise. Prevents
// double / triple fan-out when a client fires 4 satellite calls in parallel
// (main + overview + fmv-series + trades) or when React Strict Mode double-
// renders.
const inflight: Map<string, Promise<unknown>> = new Map();

const coalesce = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const existing = inflight.get(key);
  if (existing !== undefined) return existing as Promise<T>;
  const p = (async () => {
    try {
      return await fn();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
};

const cacheSet = <T>(key: string, value: T): void => {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { value, freshUntil: Date.now() + CACHE_TTL_MS });
};

/** Testing helper to clear the process-local cache. */
export const _resetCardSlugCache = (): void => {
  cache.clear();
};

// -------------------------------------------------------------------

const RENAISS_INDEX_BASE_URL = 'https://api.renaissos.com/v1';

const buildSourceForPath = (
  path: string
): { label: string; url: string } => ({
  label: 'Renaiss OS Index (beta)',
  url: `${RENAISS_INDEX_BASE_URL}${path}`,
});

// -------------------------------------------------------------------
// Route registrations
// -------------------------------------------------------------------

export const cardSlugRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // ---------------------------------------------------------------
  // Gap 3: GET /api/sets/:game/:set
  // ---------------------------------------------------------------
  app.get(
    '/sets/:game/:set',
    async (
      request: FastifyRequest<{ Params: { game: string; set: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request, 'set'))) {
        return renderTooManyRequests(reply);
      }

      const { game, set } = request.params;
      if (!isKnownGame(game)) {
        return handleError(
          reply,
          400,
          `Unknown game slug. Must be one of: ${KNOWN_GAMES.join(', ')}.`,
          'INVALID_GAME'
        );
      }
      if (!isValidSlug(set)) {
        return handleError(reply, 400, 'Invalid set slug.', 'INVALID_SLUG');
      }

      const path = `/sets/${game}/${set}`;
      const cached = cacheGet<IndexSetListing>(path);
      try {
        const data = cached ?? (await renaissIndex.getSet(game, set));
        if (cached === null) cacheSet(path, data);
        return reply
          .code(200)
          .send(buildEnvelope(data, { sources: [buildSourceForPath(path)] }));
      } catch (err) {
        if (err instanceof IndexApiError) {
          return handleIndexUpstreamError(reply, err, path);
        }
        console.error(`${LOG_PREFIX} ${path} unexpected error:`, err);
        return handleError(
          reply,
          500,
          'Failed to load set listing',
          'SET_LISTING_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  // ---------------------------------------------------------------
  // Gap 4: GET /api/cards/:game/:set/:card
  // ---------------------------------------------------------------
  app.get(
    '/cards/:game/:set/:card',
    async (
      request: FastifyRequest<{
        Params: { game: string; set: string; card: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request, 'card-slug'))) {
        return renderTooManyRequests(reply);
      }

      const { game, set, card } = request.params;
      if (!isKnownGame(game)) {
        return handleError(
          reply,
          400,
          `Unknown game slug. Must be one of: ${KNOWN_GAMES.join(', ')}.`,
          'INVALID_GAME'
        );
      }
      if (!isValidSlug(set) || !isValidSlug(card)) {
        return handleError(reply, 400, 'Invalid slug.', 'INVALID_SLUG');
      }

      const path = `/cards/${game}/${set}/${card}`;
      const cached = cacheGet<IndexCardDetail>(path);
      try {
        const data =
          cached ?? (await renaissIndex.getCardBySlug(game, set, card));
        if (cached === null) cacheSet(path, data);
        return reply
          .code(200)
          .send(buildEnvelope(data, { sources: [buildSourceForPath(path)] }));
      } catch (err) {
        if (err instanceof IndexApiError) {
          return handleIndexUpstreamError(reply, err, path);
        }
        console.error(`${LOG_PREFIX} ${path} unexpected error:`, err);
        return handleError(
          reply,
          500,
          'Failed to load card detail',
          'CARD_DETAIL_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  // ---------------------------------------------------------------
  // Gap 4: GET /api/cards/:game/:set/:card/overview
  // ---------------------------------------------------------------
  app.get(
    '/cards/:game/:set/:card/overview',
    async (
      request: FastifyRequest<{
        Params: { game: string; set: string; card: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request, 'card-slug'))) {
        return renderTooManyRequests(reply);
      }

      const { game, set, card } = request.params;
      if (!isKnownGame(game)) {
        return handleError(
          reply,
          400,
          `Unknown game slug. Must be one of: ${KNOWN_GAMES.join(', ')}.`,
          'INVALID_GAME'
        );
      }
      if (!isValidSlug(set) || !isValidSlug(card)) {
        return handleError(reply, 400, 'Invalid slug.', 'INVALID_SLUG');
      }

      const path = `/cards/${game}/${set}/${card}/overview`;
      const cached = cacheGet<IndexCardDetailOverview>(path);
      try {
        const data =
          cached ?? (await renaissIndex.getCardBySlugOverview(game, set, card));
        if (cached === null) cacheSet(path, data);
        return reply
          .code(200)
          .send(buildEnvelope(data, { sources: [buildSourceForPath(path)] }));
      } catch (err) {
        if (err instanceof IndexApiError) {
          return handleIndexUpstreamError(reply, err, path);
        }
        console.error(`${LOG_PREFIX} ${path} unexpected error:`, err);
        return handleError(
          reply,
          500,
          'Failed to load card overview',
          'CARD_OVERVIEW_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  // ---------------------------------------------------------------
  // Gap 4: GET /api/cards/:game/:set/:card/trades?limit=n
  // ---------------------------------------------------------------
  app.get(
    '/cards/:game/:set/:card/trades',
    async (
      request: FastifyRequest<{
        Params: { game: string; set: string; card: string };
        Querystring: { limit?: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request, 'card-slug'))) {
        return renderTooManyRequests(reply);
      }

      const { game, set, card } = request.params;
      if (!isKnownGame(game)) {
        return handleError(
          reply,
          400,
          `Unknown game slug. Must be one of: ${KNOWN_GAMES.join(', ')}.`,
          'INVALID_GAME'
        );
      }
      if (!isValidSlug(set) || !isValidSlug(card)) {
        return handleError(reply, 400, 'Invalid slug.', 'INVALID_SLUG');
      }

      const limit = parseLimit(request.query.limit, 50, 1, 200);
      if (limit === null) {
        return handleError(
          reply,
          400,
          'Invalid limit. Must be an integer in [1, 200].',
          'INVALID_PARAM'
        );
      }

      const path = `/cards/${game}/${set}/${card}/trades`;
      try {
        const data: IndexCardTradesResponse =
          await renaissIndex.getCardBySlugTrades(game, set, card, { limit });
        return reply.code(200).send(
          buildEnvelope(data, {
            sources: [buildSourceForPath(path)],
          })
        );
      } catch (err) {
        if (err instanceof IndexApiError) {
          return handleIndexUpstreamError(reply, err, path);
        }
        console.error(`${LOG_PREFIX} ${path} unexpected error:`, err);
        return handleError(
          reply,
          500,
          'Failed to load card trades',
          'CARD_TRADES_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  // ---------------------------------------------------------------
  // Gap 4: GET /api/cards/:game/:set/:card/series?window=7d|30d|90d
  // ---------------------------------------------------------------
  app.get(
    '/cards/:game/:set/:card/series',
    async (
      request: FastifyRequest<{
        Params: { game: string; set: string; card: string };
        Querystring: { window?: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request, 'card-slug'))) {
        return renderTooManyRequests(reply);
      }

      const { game, set, card } = request.params;
      if (!isKnownGame(game)) {
        return handleError(
          reply,
          400,
          `Unknown game slug. Must be one of: ${KNOWN_GAMES.join(', ')}.`,
          'INVALID_GAME'
        );
      }
      if (!isValidSlug(set) || !isValidSlug(card)) {
        return handleError(reply, 400, 'Invalid slug.', 'INVALID_SLUG');
      }

      const window = parseWindow(request.query.window);
      if (window === null) {
        return handleError(
          reply,
          400,
          'Invalid window. Must be one of: 7d, 30d, 90d.',
          'INVALID_PARAM'
        );
      }

      const path = `/cards/${game}/${set}/${card}/series`;
      const cacheKey = `${path}?window=${window ?? 'default'}`;
      const cached = cacheGet<IndexCardSeriesResponse>(cacheKey);
      try {
        const data: IndexCardSeriesResponse =
          cached ??
          (await renaissIndex.getCardBySlugSeries(game, set, card, { window }));
        if (cached === null) cacheSet(cacheKey, data);
        return reply.code(200).send(
          buildEnvelope(data, {
            sources: [buildSourceForPath(path)],
          })
        );
      } catch (err) {
        if (err instanceof IndexApiError) {
          return handleIndexUpstreamError(reply, err, path);
        }
        console.error(`${LOG_PREFIX} ${path} unexpected error:`, err);
        return handleError(
          reply,
          500,
          'Failed to load card series',
          'CARD_SERIES_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  // ---------------------------------------------------------------
  // Gap 4: GET /api/cards/:game/:set/:card/fmv-series?window=...
  // ---------------------------------------------------------------
  app.get(
    '/cards/:game/:set/:card/fmv-series',
    async (
      request: FastifyRequest<{
        Params: { game: string; set: string; card: string };
        Querystring: { window?: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request, 'card-slug'))) {
        return renderTooManyRequests(reply);
      }

      const { game, set, card } = request.params;
      if (!isKnownGame(game)) {
        return handleError(
          reply,
          400,
          `Unknown game slug. Must be one of: ${KNOWN_GAMES.join(', ')}.`,
          'INVALID_GAME'
        );
      }
      if (!isValidSlug(set) || !isValidSlug(card)) {
        return handleError(reply, 400, 'Invalid slug.', 'INVALID_SLUG');
      }

      const window = parseWindow(request.query.window);
      if (window === null) {
        return handleError(
          reply,
          400,
          'Invalid window. Must be one of: 7d, 30d, 90d.',
          'INVALID_PARAM'
        );
      }

      const path = `/cards/${game}/${set}/${card}/fmv-series`;
      const cacheKey = `${path}?window=${window ?? 'default'}`;
      const cached = cacheGet<IndexCardFmvSeriesResponse>(cacheKey);
      try {
        const data: IndexCardFmvSeriesResponse =
          cached ??
          (await renaissIndex.getCardBySlugFmvSeries(game, set, card, {
            window,
          }));
        if (cached === null) cacheSet(cacheKey, data);
        return reply.code(200).send(
          buildEnvelope(data, {
            sources: [buildSourceForPath(path)],
          })
        );
      } catch (err) {
        if (err instanceof IndexApiError) {
          return handleIndexUpstreamError(reply, err, path);
        }
        console.error(`${LOG_PREFIX} ${path} unexpected error:`, err);
        return handleError(
          reply,
          500,
          'Failed to load card FMV series',
          'CARD_FMV_SERIES_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  // ---------------------------------------------------------------
  // Gap 7: GET /api/cards/by-id/:id/series?window=7d|30d|90d
  //
  // RAW per-trade series (multiple points per day possible), distinct from
  // /fmv-series which is daily-aggregated FMV.
  // ---------------------------------------------------------------
  app.get(
    '/cards/by-id/:id/series',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { window?: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request, 'card-byid'))) {
        return renderTooManyRequests(reply);
      }

      const { id } = request.params;
      if (!isValidUuid(id)) {
        return handleError(
          reply,
          400,
          'Invalid id. Must be a UUID.',
          'INVALID_PARAM'
        );
      }

      const window = parseWindow(request.query.window);
      if (window === null) {
        return handleError(
          reply,
          400,
          'Invalid window. Must be one of: 7d, 30d, 90d.',
          'INVALID_PARAM'
        );
      }

      const path = `/cards/by-id/${id}/series`;
      const cacheKey = `${path}?window=${window ?? 'default'}`;
      const cached = cacheGet<IndexCardSeriesResponse>(cacheKey);
      try {
        const data: IndexCardSeriesResponse =
          cached ??
          (await renaissIndex.getCardSeries(id, { window }));
        if (cached === null) cacheSet(cacheKey, data);
        return reply.code(200).send(
          buildEnvelope(data, {
            sources: [buildSourceForPath(path)],
          })
        );
      } catch (err) {
        if (err instanceof IndexApiError) {
          return handleIndexUpstreamError(reply, err, path);
        }
        console.error(`${LOG_PREFIX} ${path} unexpected error:`, err);
        return handleError(
          reply,
          500,
          'Failed to load raw card series',
          'CARD_BYID_SERIES_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  done();
};

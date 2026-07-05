/**
 * /api/market and /api/featured REST routes (D8).
 *
 *   GET /api/market                     -> all index tiles
 *   GET /api/market/:game               -> drill-down for one game
 *   GET /api/featured?limit=n           -> featured cards
 *
 * Envelope shape per D8 brief:
 *   { data, sources: [{label, url}], warnings: [{code:"BETA"}], generated_at }
 *
 * Cache layer:
 *   - Indices tiles: 10 min in-process TTL
 *   - Featured cards: 5 min in-process TTL
 * Cache is process-local; upstream fan-out is additionally capped by the
 * Index API daily-budget guard (`assertDailyBudget`), which is triggered
 * through the underlying `renaissIndex.*` methods that our cache calls.
 *
 * Per-IP rate limit (30 requests / minute) via the atomic
 * `consumeRateLimitToken` bucket, mirroring `leaderboardRoutes` (Section
 * `http:ip:<ip>:market`).
 *
 * Per OWASP REST Cheat Sheet:
 *  - Input validation at boundary (game enum, limit bounds).
 *  - Generic error messages to clients, full details logged server-side.
 *  - No raw stack traces returned; `handleError` sanitizes.
 *  - Rate-limit by client IP.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import {
  getCachedIndices,
  getCachedIndicesByGame,
  getCachedFeatured,
  IndexApiError,
  parseCardHref,
} from '../lib/renaiss-index/index.ts';
import type {
  IndexGameSlug,
  CardSummary,
  IndexDetail,
} from '../lib/renaiss-index/index.ts';
import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import { buildEnvelope } from '../utils/envelope.ts';
import { handleError } from '../utils/errorHandler.ts';

/**
 * Enrich each card with the slug-triple parsed from its `href` so downstream
 * consumers can chain directly into the /api/cards/:game/:set/:card family
 * without re-parsing. When parseCardHref returns null the field is omitted
 * (rather than nulled) so downstream code can rely on the presence check.
 */
const enrichCardWithSlugs = <T extends { href?: unknown }>(
  card: T
): T & {
  slugs?: { game: string; setCode: string; cardSlug: string };
} => {
  const triple = parseCardHref((card as { href?: unknown }).href);
  if (triple === null) return card;
  return Object.assign({}, card, { slugs: triple });
};

const enrichCardsWithSlugs = <T extends { href?: unknown }>(cards: T[]): T[] => {
  return cards.map((c) => enrichCardWithSlugs(c) as T);
};

const LOG_PREFIX = '[market]';

const KNOWN_GAMES: readonly IndexGameSlug[] = ['pokemon', 'one-piece', 'sports'];

const INDEX_API_SOURCE = {
  label: 'Renaiss OS Index (beta)',
  url: 'https://api.renaissos.com/v1/indices',
} as const;

const FEATURED_API_SOURCE = {
  label: 'Renaiss OS Index (beta)',
  url: 'https://api.renaissos.com/v1/cards/featured',
} as const;

const FEATURED_DEFAULT_LIMIT = 6;
const FEATURED_MIN_LIMIT = 1;
const FEATURED_MAX_LIMIT = 24;

const isKnownGame = (raw: unknown): raw is IndexGameSlug => {
  return typeof raw === 'string' && (KNOWN_GAMES as readonly string[]).includes(raw);
};

const clientIp = (request: FastifyRequest): string => {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  return 'unknown';
};

const consumeIpToken = async (request: FastifyRequest): Promise<boolean> => {
  const key = `http:ip:${clientIp(request)}:market`;
  return consumeRateLimitToken(key, 30, 30);
};

const renderTooManyRequests = (reply: FastifyReply): Promise<FastifyReply> => {
  return handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');
};

/**
 * Parse ?limit=... into a bounded integer, or return `null` on invalid input.
 * We reject non-integer strings so a garbage limit does not silently downcast
 * to the default (that would mask client bugs).
 */
const parseLimit = (raw: unknown): number | null => {
  if (raw === undefined || raw === null || raw === '') return FEATURED_DEFAULT_LIMIT;
  const s = typeof raw === 'string' ? raw : String(raw);
  if (!/^-?\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return null;
  if (n < FEATURED_MIN_LIMIT || n > FEATURED_MAX_LIMIT) return null;
  return n;
};

export const marketRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // -------------------------------------------------------------------
  // GET /api/market  -> all index tiles
  // -------------------------------------------------------------------
  app.get(
    '/market',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      try {
        const tiles = await getCachedIndices();
        // Enrich each tile's topMovers with the slug-triple parsed from its
        // href so /api/market clients can chain directly into the slug family.
        const enrichedTiles = tiles.map((tile) => ({
          ...tile,
          topMovers: Array.isArray(tile.topMovers)
            ? enrichCardsWithSlugs(tile.topMovers as { href?: unknown }[])
            : tile.topMovers,
        }));
        return reply
          .code(200)
          .send(
            buildEnvelope(
              { indices: enrichedTiles },
              { sources: [INDEX_API_SOURCE] }
            )
          );
      } catch (err) {
        if (err instanceof IndexApiError) {
          console.warn(`${LOG_PREFIX} indices upstream failed status=${err.status}`);
          if (err.status === 429) {
            return handleError(
              reply,
              503,
              'Renaiss OS Index is rate-limiting our backend. Live data is paused until the quota resets.',
              'INDEX_API_RATE_LIMITED'
            );
          }
          return handleError(
            reply,
            502,
            'Index API unavailable. Please try again shortly.',
            'INDEX_API_UNAVAILABLE'
          );
        }
        console.error(`${LOG_PREFIX} indices unexpected error:`, err);
        return handleError(
          reply,
          500,
          'Failed to load market indices',
          'MARKET_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  // -------------------------------------------------------------------
  // GET /api/market/:game  -> drill-down
  // -------------------------------------------------------------------
  app.get(
    '/market/:game',
    async (
      request: FastifyRequest<{ Params: { game: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const gameRaw = request.params.game;
      if (!isKnownGame(gameRaw)) {
        return handleError(
          reply,
          400,
          `Unknown game slug. Must be one of: ${KNOWN_GAMES.join(', ')}.`,
          'INVALID_GAME'
        );
      }

      try {
        const detail = await getCachedIndicesByGame(gameRaw);
        // Enrich constituents / topMovers with the slug-triple parsed from
        // each `href` so downstream consumers can chain into /api/cards/:game/:set/:card
        // without re-parsing. Non-parseable entries are passed through untouched.
        const constituents = Array.isArray(detail.constituents)
          ? enrichCardsWithSlugs(detail.constituents as { href?: unknown }[])
          : detail.constituents;
        const topMovers = Array.isArray(detail.topMovers)
          ? enrichCardsWithSlugs(detail.topMovers as { href?: unknown }[])
          : detail.topMovers;
        const enrichedDetail: IndexDetail = {
          ...detail,
          constituents,
          topMovers,
        } as IndexDetail;
        return reply.code(200).send(
          buildEnvelope(enrichedDetail, {
            sources: [
              {
                label: INDEX_API_SOURCE.label,
                url: `https://api.renaissos.com/v1/indices/${gameRaw}`,
              },
            ],
          })
        );
      } catch (err) {
        if (err instanceof IndexApiError) {
          if (err.status === 404) {
            return handleError(reply, 404, 'Index not found', 'INDEX_NOT_FOUND');
          }
          console.warn(
            `${LOG_PREFIX} indices/${gameRaw} upstream failed status=${err.status}`
          );
          if (err.status === 429) {
            return handleError(
              reply,
              503,
              'Renaiss OS Index is rate-limiting our backend. Live data is paused until the quota resets.',
              'INDEX_API_RATE_LIMITED'
            );
          }
          return handleError(
            reply,
            502,
            'Index API unavailable. Please try again shortly.',
            'INDEX_API_UNAVAILABLE'
          );
        }
        console.error(`${LOG_PREFIX} indices/${gameRaw} unexpected error:`, err);
        return handleError(
          reply,
          500,
          'Failed to load market drill-down',
          'MARKET_DETAIL_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  // -------------------------------------------------------------------
  // GET /api/featured?limit=n  -> featured cards
  // -------------------------------------------------------------------
  app.get(
    '/featured',
    async (
      request: FastifyRequest<{ Querystring: { limit?: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const limit = parseLimit(request.query.limit);
      if (limit === null) {
        return handleError(
          reply,
          400,
          `Invalid limit. Must be an integer in [${FEATURED_MIN_LIMIT}, ${FEATURED_MAX_LIMIT}].`,
          'INVALID_PARAM'
        );
      }

      try {
        const cards = await getCachedFeatured(limit);
        const enriched = enrichCardsWithSlugs(cards as CardSummary[]);
        return reply
          .code(200)
          .send(
            buildEnvelope(
              { limit, cards: enriched },
              { sources: [FEATURED_API_SOURCE] }
            )
          );
      } catch (err) {
        if (err instanceof IndexApiError) {
          console.warn(
            `${LOG_PREFIX} featured upstream failed limit=${limit} status=${err.status}`
          );
          if (err.status === 429) {
            return handleError(
              reply,
              503,
              'Renaiss OS Index is rate-limiting our backend. Live data is paused until the quota resets.',
              'INDEX_API_RATE_LIMITED'
            );
          }
          return handleError(
            reply,
            502,
            'Index API unavailable. Please try again shortly.',
            'INDEX_API_UNAVAILABLE'
          );
        }
        console.error(`${LOG_PREFIX} featured unexpected error:`, err);
        return handleError(
          reply,
          500,
          'Failed to load featured cards',
          'FEATURED_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  done();
};

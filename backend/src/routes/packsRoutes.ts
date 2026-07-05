/**
 * /api/packs REST routes.
 *
 *  GET /api/packs?includeInactive=false  Renaiss main API pack list, cached.
 *
 * Per-IP token bucket rate limit (30 rpm) via `consumeRateLimitToken`. Envelope
 * shaped by `buildEnvelope` with `SOURCE_RENAISS_MAIN` so the disclosure
 * surface stays consistent with the rest of /api/*.
 *
 * An in-process TTL cache (5 min) keyed by the `includeInactive` toggle keeps
 * us off the upstream during traffic bursts. The cache is per-process (no
 * Redis coordination) which is fine for the hackathon surface.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import {
  renaissApi,
  RenaissApiError,
  type RenaissPackListItem,
} from '../lib/renaiss/index.ts';
import { buildEnvelope, SOURCE_RENAISS_MAIN } from '../utils/envelope.ts';
import { handleError } from '../utils/errorHandler.ts';

const LOG_PREFIX = '[packs]';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_CAPACITY = 30;
const RATE_LIMIT_REFILL = 30; // 30 tokens per minute

interface CacheEntry {
  storedAt: number;
  packs: RenaissPackListItem[];
}

const cache = new Map<string, CacheEntry>();

const cacheKey = (includeInactive: boolean): string => `packs:v1:${includeInactive ? 'all' : 'active'}`;

const getFromCache = (key: string): RenaissPackListItem[] | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.packs;
};

const putInCache = (key: string, packs: RenaissPackListItem[]): void => {
  cache.set(key, { storedAt: Date.now(), packs });
};

const clientIp = (request: FastifyRequest): string => {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  return 'unknown';
};

const consumeIpToken = async (request: FastifyRequest): Promise<boolean> => {
  const key = `http:ip:${clientIp(request)}:packs`;
  return consumeRateLimitToken(key, RATE_LIMIT_CAPACITY, RATE_LIMIT_REFILL);
};

const renderTooManyRequests = (reply: FastifyReply): Promise<FastifyReply> => {
  return handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');
};

const parseIncludeInactive = (raw: unknown): boolean => {
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
};

/**
 * Test-only cache reset. Exported for `tests/renaiss-packs-list.test.ts` so a
 * fresh route setup does not see stale data across `describe` blocks.
 */
export const __resetPacksCacheForTests = (): void => {
  cache.clear();
};

export const packsRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // -------------------------------------------------------------------
  // GET /api/packs
  // -------------------------------------------------------------------
  app.get(
    '/packs',
    async (
      request: FastifyRequest<{ Querystring: { includeInactive?: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const includeInactive = parseIncludeInactive(request.query.includeInactive);
      const key = cacheKey(includeInactive);

      let packs = getFromCache(key);
      if (packs === null) {
        try {
          packs = await renaissApi.getPacks({ includeInactive });
        } catch (err) {
          if (err instanceof RenaissApiError) {
            console.warn(
              `${LOG_PREFIX} upstream failed includeInactive=${includeInactive} status=${err.status}`
            );
          } else {
            console.error(`${LOG_PREFIX} unexpected error:`, err);
          }
          return handleError(
            reply,
            502,
            'Renaiss main API unreachable',
            'UPSTREAM_UNAVAILABLE',
            err instanceof Error ? err : null
          );
        }
        putInCache(key, packs);
      }

      const payload = {
        includeInactive,
        packs,
      };

      return reply
        .code(200)
        .send(buildEnvelope(payload, { sources: [SOURCE_RENAISS_MAIN] }));
    }
  );

  // -------------------------------------------------------------------
  // GET /api/packs/:slug
  // -------------------------------------------------------------------
  app.get(
    '/packs/:slug',
    async (
      request: FastifyRequest<{ Params: { slug: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const slugRaw = request.params.slug;
      // Slug validation: lowercase alphanumeric + dash, 1-64 chars. Same shape
      // upstream advertises for pack slugs; rejecting here means no upstream
      // round trip for obviously-bad input.
      if (typeof slugRaw !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(slugRaw)) {
        return handleError(reply, 400, 'Invalid slug', 'INVALID_PARAM');
      }
      const slug = slugRaw.toLowerCase();

      try {
        const pack = await renaissApi.getPack(slug);
        return reply
          .code(200)
          .send(buildEnvelope({ pack }, { sources: [SOURCE_RENAISS_MAIN] }));
      } catch (err) {
        if (err instanceof RenaissApiError) {
          if (err.status !== null && err.status >= 400 && err.status < 500) {
            return handleError(
              reply,
              404,
              `Pack ${slug} not found`,
              'PACK_NOT_FOUND'
            );
          }
          console.warn(
            `${LOG_PREFIX} pack detail failed slug=${slug} status=${err.status}`
          );
        } else {
          console.error(`${LOG_PREFIX} pack detail unexpected:`, err);
        }
        return handleError(
          reply,
          502,
          'Renaiss main API unreachable',
          'UPSTREAM_UNAVAILABLE',
          err instanceof Error ? err : null
        );
      }
    }
  );

  done();
};

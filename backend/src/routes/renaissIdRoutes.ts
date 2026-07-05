/**
 * D9: /api/cards/renaiss-id/:rid/* REST routes.
 *
 * Bridge endpoint family that surfaces the 5 Renaiss OS Index API
 * `by-renaiss-id/{rid}` routes:
 *
 *   GET /api/cards/renaiss-id/:rid              detail
 *   GET /api/cards/renaiss-id/:rid/overview     grade-blended overview
 *   GET /api/cards/renaiss-id/:rid/trades       trade history
 *   GET /api/cards/renaiss-id/:rid/series       daily price series
 *   GET /api/cards/renaiss-id/:rid/fmv-series   daily FMV series
 *
 * Per-IP rate limit: 30 requests / minute via the shared atomic bucket
 * `http:ip:<ip>:renaiss-id`. Standard envelope (buildEnvelope) with
 * `SOURCE_RENAISS_INDEX` and BETA_WARNING.
 *
 * Auth: NONE (matches every other /api/* route today; consistent posture per
 * memory/backend_patterns.md — no cookie/bearer surface, so wildcard CORS is
 * fine).
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import {
  IndexApiError,
  renaissIndex,
} from '../lib/renaiss-index/index.ts';
import {
  buildEnvelope,
  SOURCE_RENAISS_INDEX,
  type EnvelopeSource,
} from '../utils/envelope.ts';
import { handleError } from '../utils/errorHandler.ts';
import {
  validateLimit,
  validateRenaissId,
} from '../utils/paramValidators.ts';

const LOG_PREFIX = '[renaiss-id]';

const TRADES_DEFAULT_LIMIT = 50;
const TRADES_MIN_LIMIT = 1;
const TRADES_MAX_LIMIT = 200;

const clientIp = (request: FastifyRequest): string => {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  return 'unknown';
};

const consumeIpToken = async (request: FastifyRequest): Promise<boolean> => {
  const key = `http:ip:${clientIp(request)}:renaiss-id`;
  // 30 capacity + 30 refill per minute per brief.
  return consumeRateLimitToken(key, 30, 30);
};

const renderTooManyRequests = (reply: FastifyReply): Promise<FastifyReply> => {
  return handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');
};

/**
 * Normalize the `?window=` query into the string form the client expects
 * ('30d'|'90d') or leave undefined so the client uses its default. Anything
 * else is a 400.
 *
 * NOTE: '7d' is REJECTED because the upstream OpenAPI enum only supports
 * {30, 90, 365, 1095, 36500}; we surface a 400 rather than silently coerce to
 * 30 so consumers of /api/cards/renaiss-id/:rid/series know their input was
 * ignored.
 */
const parseWindow = (raw: unknown): '7d' | '30d' | '90d' | null | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (raw === '30d') return '30d';
  if (raw === '90d') return '90d';
  if (raw === '7d') return '7d';
  return null;
};

const sourceForRid = (rid: string, subpath: string): EnvelopeSource => ({
  label: SOURCE_RENAISS_INDEX.label,
  url: `${SOURCE_RENAISS_INDEX.url}/cards/by-renaiss-id/${encodeURIComponent(rid)}${subpath}`,
});

const handleIndexError = (
  reply: FastifyReply,
  err: unknown,
  rid: string,
  endpoint: string
): Promise<FastifyReply> => {
  if (err instanceof IndexApiError) {
    const status = err.status;
    if (status === 404) {
      console.log(`${LOG_PREFIX} rid not found rid=${rid} endpoint=${endpoint}`);
      return handleError(
        reply,
        404,
        `Renaiss item id ${rid} not found in Index API.`,
        'RID_NOT_FOUND'
      );
    }
    if (status !== null && status >= 400 && status < 500) {
      console.warn(
        `${LOG_PREFIX} client error rid=${rid} endpoint=${endpoint} status=${status}`
      );
      return handleError(
        reply,
        status,
        `Renaiss Index API rejected request (${status}).`,
        'UPSTREAM_CLIENT_ERROR'
      );
    }
    console.error(
      `${LOG_PREFIX} upstream error rid=${rid} endpoint=${endpoint} status=${status}`,
      err
    );
    return handleError(
      reply,
      502,
      'Renaiss Index API unreachable',
      'UPSTREAM_UNAVAILABLE',
      err instanceof Error ? err : null
    );
  }
  console.error(
    `${LOG_PREFIX} unexpected error rid=${rid} endpoint=${endpoint}:`,
    err
  );
  return handleError(
    reply,
    502,
    'Renaiss Index API unreachable',
    'UPSTREAM_UNAVAILABLE',
    err instanceof Error ? err : null
  );
};

export const renaissIdRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // -----------------------------------------------------------------
  // GET /api/cards/renaiss-id/:rid
  // -----------------------------------------------------------------
  app.get(
    '/renaiss-id/:rid',
    async (
      request: FastifyRequest<{ Params: { rid: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const rid = validateRenaissId(request.params.rid);
      if (rid === null) {
        return handleError(
          reply,
          400,
          'Invalid rid. Expected a UUID (8-4-4-4-12 hex).',
          'INVALID_PARAM'
        );
      }

      try {
        const data = await renaissIndex.getCardByRenaissId(rid);
        return reply.code(200).send(
          buildEnvelope(data, {
            sources: [sourceForRid(rid, '')],
          })
        );
      } catch (err) {
        return handleIndexError(reply, err, rid, '/detail');
      }
    }
  );

  // -----------------------------------------------------------------
  // GET /api/cards/renaiss-id/:rid/overview
  // -----------------------------------------------------------------
  app.get(
    '/renaiss-id/:rid/overview',
    async (
      request: FastifyRequest<{ Params: { rid: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const rid = validateRenaissId(request.params.rid);
      if (rid === null) {
        return handleError(
          reply,
          400,
          'Invalid rid. Expected a UUID (8-4-4-4-12 hex).',
          'INVALID_PARAM'
        );
      }

      try {
        const data = await renaissIndex.getCardByRenaissIdOverview(rid);
        return reply.code(200).send(
          buildEnvelope(data, {
            sources: [sourceForRid(rid, '/overview')],
          })
        );
      } catch (err) {
        return handleIndexError(reply, err, rid, '/overview');
      }
    }
  );

  // -----------------------------------------------------------------
  // GET /api/cards/renaiss-id/:rid/trades?limit=n
  // -----------------------------------------------------------------
  app.get(
    '/renaiss-id/:rid/trades',
    async (
      request: FastifyRequest<{
        Params: { rid: string };
        Querystring: { limit?: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const rid = validateRenaissId(request.params.rid);
      if (rid === null) {
        return handleError(
          reply,
          400,
          'Invalid rid. Expected a UUID (8-4-4-4-12 hex).',
          'INVALID_PARAM'
        );
      }

      const limit = validateLimit(
        request.query.limit,
        TRADES_DEFAULT_LIMIT,
        TRADES_MIN_LIMIT,
        TRADES_MAX_LIMIT
      );
      if (limit === null) {
        return handleError(
          reply,
          400,
          `Invalid limit. Must be an integer in [${TRADES_MIN_LIMIT}, ${TRADES_MAX_LIMIT}].`,
          'INVALID_PARAM'
        );
      }

      try {
        const data = await renaissIndex.getCardByRenaissIdTrades(rid, { limit });
        return reply.code(200).send(
          buildEnvelope(data, {
            sources: [sourceForRid(rid, '/trades')],
          })
        );
      } catch (err) {
        return handleIndexError(reply, err, rid, '/trades');
      }
    }
  );

  // -----------------------------------------------------------------
  // GET /api/cards/renaiss-id/:rid/series?window=7d|30d|90d
  // -----------------------------------------------------------------
  app.get(
    '/renaiss-id/:rid/series',
    async (
      request: FastifyRequest<{
        Params: { rid: string };
        Querystring: { window?: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const rid = validateRenaissId(request.params.rid);
      if (rid === null) {
        return handleError(
          reply,
          400,
          'Invalid rid. Expected a UUID (8-4-4-4-12 hex).',
          'INVALID_PARAM'
        );
      }

      const window = parseWindow(request.query.window);
      if (window === null) {
        return handleError(
          reply,
          400,
          'Invalid window. Expected 7d, 30d, or 90d.',
          'INVALID_PARAM'
        );
      }

      try {
        const data = await renaissIndex.getCardByRenaissIdSeries(rid, { window });
        return reply.code(200).send(
          buildEnvelope(data, {
            sources: [sourceForRid(rid, '/series')],
          })
        );
      } catch (err) {
        return handleIndexError(reply, err, rid, '/series');
      }
    }
  );

  // -----------------------------------------------------------------
  // GET /api/cards/renaiss-id/:rid/fmv-series?window=7d|30d|90d
  // -----------------------------------------------------------------
  app.get(
    '/renaiss-id/:rid/fmv-series',
    async (
      request: FastifyRequest<{
        Params: { rid: string };
        Querystring: { window?: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const rid = validateRenaissId(request.params.rid);
      if (rid === null) {
        return handleError(
          reply,
          400,
          'Invalid rid. Expected a UUID (8-4-4-4-12 hex).',
          'INVALID_PARAM'
        );
      }

      const window = parseWindow(request.query.window);
      if (window === null) {
        return handleError(
          reply,
          400,
          'Invalid window. Expected 7d, 30d, or 90d.',
          'INVALID_PARAM'
        );
      }

      try {
        const data = await renaissIndex.getCardByRenaissIdFmvSeries(rid, {
          window,
        });
        return reply.code(200).send(
          buildEnvelope(data, {
            sources: [sourceForRid(rid, '/fmv-series')],
          })
        );
      } catch (err) {
        return handleIndexError(reply, err, rid, '/fmv-series');
      }
    }
  );

  done();
};

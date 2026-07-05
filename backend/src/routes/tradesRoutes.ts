/**
 * GET /api/trades/recent — Renaiss OS Index live trade feed.
 *
 * Proxies GET /v1/trades/recent with rate limiting and canonical envelope.
 * Showcases Index API cross-market trade data (snkrdunk, partner shops, etc.).
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { renaissIndex, IndexApiError } from '../lib/renaiss-index/index.ts';
import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import { buildEnvelope } from '../utils/envelope.ts';
import { handleError } from '../utils/errorHandler.ts';
import { validateLimit } from '../utils/paramValidators.ts';

const LOG_PREFIX = '[trades]';
const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

// In-process TTL cache keyed by `limit` to avoid hammering upstream.
// Fresh window: 30s. Stale-serve window: 5m on upstream failure.
const TRADES_FRESH_TTL_MS = 30_000;
const TRADES_STALE_TTL_MS = 5 * 60_000;

interface TradesCacheEntry {
  value: unknown[];
  freshUntil: number;
  staleUntil: number;
}

const tradesCache: Map<number, TradesCacheEntry> = new Map();

const clientIp = (request: FastifyRequest): string => {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  return 'unknown';
};

const consumeIpToken = async (request: FastifyRequest): Promise<boolean> => {
  const key = `http:ip:${clientIp(request)}:trades`;
  return consumeRateLimitToken(key, 30, 30);
};

export const tradesRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/recent',
    async (
      request: FastifyRequest<{ Querystring: { limit?: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) {
        return handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');
      }

      const limit = validateLimit(
        request.query.limit,
        DEFAULT_LIMIT,
        MIN_LIMIT,
        MAX_LIMIT
      );
      if (limit === null) {
        return handleError(
          reply,
          400,
          `Invalid limit. Must be an integer in [${MIN_LIMIT}, ${MAX_LIMIT}].`,
          'INVALID_PARAM'
        );
      }

      const nowMs = Date.now();
      const cached = tradesCache.get(limit);
      // Fresh cache hit -> return immediately.
      if (cached && cached.freshUntil > nowMs) {
        return reply.code(200).send(
          buildEnvelope(
            { limit, trades: cached.value },
            {
              sources: [
                {
                  label: 'Renaiss OS Index recent trades (beta)',
                  url: 'https://api.renaissos.com/v1/trades/recent',
                },
              ],
            }
          )
        );
      }

      try {
        const trades = await renaissIndex.getRecentTrades({ limit });
        tradesCache.set(limit, {
          value: trades,
          freshUntil: nowMs + TRADES_FRESH_TTL_MS,
          staleUntil: nowMs + TRADES_STALE_TTL_MS,
        });
        return reply.code(200).send(
          buildEnvelope(
            { limit, trades },
            {
              sources: [
                {
                  label: 'Renaiss OS Index recent trades (beta)',
                  url: 'https://api.renaissos.com/v1/trades/recent',
                },
              ],
            }
          )
        );
      } catch (err) {
        // Stale-serve when upstream fails and we still have a not-expired entry.
        if (cached && cached.staleUntil > nowMs) {
          if (err instanceof IndexApiError) {
            console.warn(
              `${LOG_PREFIX} upstream failed status=${err.status}, serving stale`
            );
          }
          return reply.code(200).send(
            buildEnvelope(
              { limit, trades: cached.value },
              {
                sources: [
                  {
                    label: 'Renaiss OS Index recent trades (beta)',
                    url: 'https://api.renaissos.com/v1/trades/recent',
                  },
                ],
                warnings: [
                  {
                    code: 'STALE',
                    message:
                      'Upstream rate-limited or unavailable; serving cached trades.',
                  },
                ],
              }
            )
          );
        }
        if (err instanceof IndexApiError) {
          console.warn(`${LOG_PREFIX} upstream failed status=${err.status}`);
          if (err.status === 429) {
            return handleError(
              reply,
              503,
              'Renaiss OS Index is rate-limiting our backend. Live trades are paused until the quota resets.',
              'INDEX_API_RATE_LIMITED'
            );
          }
        } else {
          console.error(`${LOG_PREFIX} unexpected:`, err);
        }
        return handleError(
          reply,
          502,
          'Renaiss Index API unreachable',
          'UPSTREAM_UNAVAILABLE',
          err instanceof Error ? err : null
        );
      }
    }
  );

  done();
};

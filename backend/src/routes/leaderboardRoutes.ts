/**
 * /api/leaderboard/* REST routes.
 *
 *   GET /api/leaderboard/daily            latest 5 snapshots ordered by rank ASC
 *   GET /api/leaderboard/history?limit=24 last N hourly snapshots (cap 168)
 *
 * Per-IP rate limit on both via atomic `consumeRateLimitToken` bucket
 * `http:ip:<ip>:leaderboard` (30 capacity, 30 refill per minute).
 *
 * All responses wrapped with the canonical envelope (buildEnvelope) which
 * embeds `_disclosure` inside `data`. Pull projection mirrors
 * `/api/pulls` exactly (no `rawAttributesJson`, no `txHash`, no `blockNumber`,
 * no `backImageUrl`).
 *
 * All queries filter `deletedAt: null` (Pull + LeaderboardSnapshot both).
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { prismaQuery } from '../lib/prisma.ts';
import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import { buildEnvelope } from '../utils/envelope.ts';
import { handleError } from '../utils/errorHandler.ts';
import {
  PULL_PUBLIC_SELECT,
  type PullPublicProjection,
  validateLimit,
} from '../utils/paramValidators.ts';

const LOG_PREFIX = '[leaderboard]';

const HISTORY_DEFAULT_LIMIT = 24;
const HISTORY_MIN_LIMIT = 1;
const HISTORY_MAX_LIMIT = 168; // one week of hourly snapshots
const TOP_N = 5;

interface DailyEntry {
  rank: number;
  pull: PullPublicProjection;
  netGainUsdCents: number;
  fmvUsdCents: number | null;
}

/**
 * Local row shape for LeaderboardSnapshot reads with the `pull` include.
 * We do not depend on Prisma's generated row type because the generated
 * client only exists post-`bun run db:push`, but the prisma client at
 * runtime returns rows structurally compatible with this interface.
 */
interface SnapshotWithPull {
  rank: number;
  windowStartAt: Date;
  windowEndAt: Date;
  computedAt: Date;
  netGainUsdCents: number;
  fmvUsdCents: number | null;
  pull: PullPublicProjection;
}

const clientIp = (request: FastifyRequest): string => {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  return 'unknown';
};

const consumeIpToken = async (request: FastifyRequest): Promise<boolean> => {
  const key = `http:ip:${clientIp(request)}:leaderboard`;
  return consumeRateLimitToken(key, 30, 30);
};

const renderTooManyRequests = (reply: FastifyReply): Promise<FastifyReply> => {
  return handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');
};

export const leaderboardRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // -------------------------------------------------------------------
  // GET /api/leaderboard/daily
  // -------------------------------------------------------------------
  app.get(
    '/daily',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      try {
        // The worker writes 5 rows per windowEndAt. The latest windowEndAt's
        // rows are the current leaderboard. We fetch by joining on
        // (windowEndAt = latest) in one query rather than two: first find
        // latest windowEndAt, then findMany with the include.
        const latest = await prismaQuery.leaderboardSnapshot.findFirst({
          where: { deletedAt: null },
          orderBy: { windowEndAt: 'desc' },
          select: { windowEndAt: true, windowStartAt: true, computedAt: true },
        });

        if (latest === null) {
          // Empty-state response: no snapshots computed yet. Synthesize a
          // labeling window so the client can render the empty state with
          // honest "trailing 24h" labels.
          const now = new Date();
          const windowEndAt = now;
          const windowStartAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          const payload = {
            windowStartAt: windowStartAt.toISOString(),
            windowEndAt: windowEndAt.toISOString(),
            computedAt: now.toISOString(),
            entries: [] as DailyEntry[],
          };
          return reply.code(200).send(
            buildEnvelope(payload, {
              sources: [
                {
                  label: 'PullCast leaderboard (derived from indexed Pulls)',
                  url: 'https://pullcast.xyz/api/leaderboard/daily',
                },
              ],
            })
          );
        }

        const snapshots = await prismaQuery.leaderboardSnapshot.findMany({
          where: {
            windowEndAt: latest.windowEndAt,
            deletedAt: null,
          },
          orderBy: { rank: 'asc' },
          take: TOP_N,
          include: {
            pull: {
              select: PULL_PUBLIC_SELECT,
            },
          },
        });

        const entries: DailyEntry[] = snapshots.map((s: SnapshotWithPull) => ({
          rank: s.rank,
          pull: s.pull,
          netGainUsdCents: s.netGainUsdCents,
          fmvUsdCents: s.fmvUsdCents,
        }));

        const payload = {
          windowStartAt: latest.windowStartAt.toISOString(),
          windowEndAt: latest.windowEndAt.toISOString(),
          computedAt: latest.computedAt.toISOString(),
          entries,
        };

        return reply.code(200).send(
          buildEnvelope(payload, {
            sources: [
              {
                label: 'PullCast leaderboard (derived from indexed Pulls)',
                url: 'https://pullcast.xyz/api/leaderboard/daily',
              },
            ],
          })
        );
      } catch (err) {
        console.error(`${LOG_PREFIX} daily failed:`, err);
        return handleError(
          reply,
          500,
          'Failed to load leaderboard',
          'LEADERBOARD_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  // -------------------------------------------------------------------
  // GET /api/leaderboard/history?limit=24
  // -------------------------------------------------------------------
  app.get(
    '/history',
    async (
      request: FastifyRequest<{ Querystring: { limit?: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const limit = validateLimit(
        request.query.limit,
        HISTORY_DEFAULT_LIMIT,
        HISTORY_MIN_LIMIT,
        HISTORY_MAX_LIMIT
      );
      if (limit === null) {
        return handleError(
          reply,
          400,
          `Invalid limit. Must be an integer in [${HISTORY_MIN_LIMIT}, ${HISTORY_MAX_LIMIT}].`,
          'INVALID_PARAM'
        );
      }

      try {
        // Pull the top-1 (rank=1) snapshot from each of the last `limit`
        // hourly windows. windowEndAt DESC + rank=1 gives one row per window.
        const rows = await prismaQuery.leaderboardSnapshot.findMany({
          where: { rank: 1, deletedAt: null },
          orderBy: { windowEndAt: 'desc' },
          take: limit,
          include: {
            pull: {
              select: PULL_PUBLIC_SELECT,
            },
          },
        });

        const items = rows.map((s: SnapshotWithPull) => ({
          windowEndAt: s.windowEndAt.toISOString(),
          computedAt: s.computedAt.toISOString(),
          top1: {
            pull: s.pull,
            netGainUsdCents: s.netGainUsdCents,
          },
        }));

        return reply.code(200).send(
          buildEnvelope(
            { limit, items },
            {
              sources: [
                {
                  label: 'PullCast leaderboard history (rank=1 hourly)',
                  url: 'https://pullcast.xyz/api/leaderboard/history',
                },
              ],
            }
          )
        );
      } catch (err) {
        console.error(`${LOG_PREFIX} history failed:`, err);
        return handleError(
          reply,
          500,
          'Failed to load leaderboard history',
          'LEADERBOARD_HISTORY_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  done();
};

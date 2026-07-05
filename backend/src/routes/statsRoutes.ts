/**
 * GET /api/stats — adoption metrics for the web gallery and README.
 *
 * Aggregates from Postgres (Pull + Subscription). No upstream Renaiss calls.
 * Every response uses the canonical envelope with beta disclosure.
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

const LOG_PREFIX = '[stats]';

interface StatsPayload {
  cardsShared: number;
  walletsTracked: number;
  discordServers: number;
  delta24h: {
    cardsShared: number;
    walletsTracked: number;
    discordServers: number;
  };
}

const clientIp = (request: FastifyRequest): string => {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  return 'unknown';
};

const consumeIpToken = async (request: FastifyRequest): Promise<boolean> => {
  const key = `http:ip:${clientIp(request)}:stats`;
  return consumeRateLimitToken(key, 60, 60);
};

export const statsRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await consumeIpToken(request))) {
      return handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');
    }

    try {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [
        cardsShared,
        cardsShared24h,
        walletSubs,
        walletSubs24h,
        guildSubs,
        guildSubs24h,
        distinctBuyers,
        distinctBuyers24h,
      ] = await Promise.all([
        prismaQuery.pull.count({
          where: { deletedAt: null, shareCardPostedAt: { not: null } },
        }),
        prismaQuery.pull.count({
          where: {
            deletedAt: null,
            shareCardPostedAt: { gte: dayAgo },
          },
        }),
        prismaQuery.subscription.findMany({
          where: { deletedAt: null, walletAddress: { not: null } },
          distinct: ['walletAddress'],
          select: { walletAddress: true },
        }),
        prismaQuery.subscription.findMany({
          where: {
            deletedAt: null,
            walletAddress: { not: null },
            createdAt: { gte: dayAgo },
          },
          distinct: ['walletAddress'],
          select: { walletAddress: true },
        }),
        prismaQuery.subscription.findMany({
          where: { deletedAt: null },
          distinct: ['discordGuildId'],
          select: { discordGuildId: true },
        }),
        prismaQuery.subscription.findMany({
          where: { deletedAt: null, createdAt: { gte: dayAgo } },
          distinct: ['discordGuildId'],
          select: { discordGuildId: true },
        }),
        prismaQuery.pull.findMany({
          where: { deletedAt: null },
          distinct: ['buyerAddress'],
          select: { buyerAddress: true },
        }),
        prismaQuery.pull.findMany({
          where: { deletedAt: null, createdAt: { gte: dayAgo } },
          distinct: ['buyerAddress'],
          select: { buyerAddress: true },
        }),
      ]);

      const subscribedWallets = walletSubs.length;
      const indexedWallets = distinctBuyers.length;
      const walletsTracked = Math.max(subscribedWallets, indexedWallets);

      const subscribedWallets24h = walletSubs24h.length;
      const indexedWallets24h = distinctBuyers24h.length;
      const walletsTracked24h = Math.max(subscribedWallets24h, indexedWallets24h);

      const payload: StatsPayload = {
        cardsShared,
        walletsTracked,
        discordServers: guildSubs.length,
        delta24h: {
          cardsShared: cardsShared24h,
          walletsTracked: walletsTracked24h,
          discordServers: guildSubs24h.length,
        },
      };

      return reply.code(200).send(
        buildEnvelope(payload, {
          sources: [
            {
              label: 'PullCast adoption (Postgres aggregates)',
              url: 'https://pullcast.xyz/api/stats',
            },
          ],
        })
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} failed:`, err);
      return handleError(
        reply,
        500,
        'Failed to load stats',
        'STATS_FAILED',
        err instanceof Error ? err : null
      );
    }
  });

  done();
};

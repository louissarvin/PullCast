/**
 * Pull + wallet gallery REST routes.
 *
 * Endpoints (registered under `/api`):
 *  - GET /pulls                       global feed, newest first, cursor paginated
 *  - GET /pulls/:id                   single pull lookup
 *  - GET /wallets/:address/pulls      per-wallet gallery, newest first
 *
 * Pagination shape: cursor + nextCursor (keyset over pulledAtTimestamp DESC).
 * The cursor is the last item's `id`; the server resolves it back to a
 * (pulledAtTimestamp, id) tuple to seek past the boundary deterministically
 * even when two Pulls share a timestamp (rare but possible).
 *
 * Every response goes through the canonical envelope (buildEnvelope) which
 * embeds `_disclosure` inside `data` so JSON consumers cannot drop it.
 *
 * All queries filter `deletedAt: null`. Field projection is locked via
 * `PULL_PUBLIC_SELECT` so we never leak `rawAttributesJson`, `txHash`, etc.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { prismaQuery } from '../lib/prisma.ts';
import { buildEnvelope } from '../utils/envelope.ts';
import { handleError, handleNotFoundError } from '../utils/errorHandler.ts';
import {
  PULL_PUBLIC_SELECT,
  type PullPublicProjection,
  validateCursor,
  validateLimit,
  validatePullId,
  validateWalletAddress,
} from '../utils/paramValidators.ts';

const LOG_PREFIX = '[pulls]';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MIN_LIMIT = 1;

interface ListPullsResult {
  pulls: PullPublicProjection[];
  nextCursor: string | null;
}

/**
 * Keyset pagination helper. Given an optional cursor (a Pull id), resolve it
 * to a (pulledAtTimestamp, id) tuple so we can do strict ordering.
 *
 * Returns `null` when the cursor id does not exist (the client may have
 * deleted/expired ids); the caller treats that as "start from the beginning".
 */
const resolveCursorTuple = async (
  cursorId: string | undefined
): Promise<{ pulledAtTimestamp: Date; id: string } | null> => {
  if (!cursorId) return null;
  try {
    const row = await prismaQuery.pull.findFirst({
      where: { id: cursorId, deletedAt: null },
      select: { pulledAtTimestamp: true, id: true },
    });
    return row ?? null;
  } catch (err) {
    console.warn(`${LOG_PREFIX} cursor resolve failed id=${cursorId}:`, err);
    return null;
  }
};

/**
 * Run a paginated Pull query with optional buyerAddress filter. Returns the
 * page plus the next cursor (null when no more pages).
 */
const listPullsPage = async (opts: {
  buyerAddress?: string;
  limit: number;
  cursorTuple: { pulledAtTimestamp: Date; id: string } | null;
}): Promise<ListPullsResult> => {
  const { buyerAddress, limit, cursorTuple } = opts;

  // Keyset predicate: rows where (pulledAtTimestamp, id) is strictly less than
  // the cursor (DESC). Use the lexicographic OR pattern so Postgres can use the
  // composite index `(buyerAddress, pulledAtTimestamp DESC)` or
  // `(pulledAtTimestamp DESC)` efficiently.
  const baseWhere: Record<string, unknown> = { deletedAt: null };
  if (buyerAddress !== undefined) {
    baseWhere.buyerAddress = buyerAddress;
  }

  const where = cursorTuple
    ? {
        ...baseWhere,
        OR: [
          { pulledAtTimestamp: { lt: cursorTuple.pulledAtTimestamp } },
          {
            pulledAtTimestamp: cursorTuple.pulledAtTimestamp,
            id: { lt: cursorTuple.id },
          },
        ],
      }
    : baseWhere;

  // Fetch one extra row to know whether a next page exists.
  const rows = await prismaQuery.pull.findMany({
    where,
    select: PULL_PUBLIC_SELECT,
    orderBy: [{ pulledAtTimestamp: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  let nextCursor: string | null = null;
  let page = rows;
  if (rows.length > limit) {
    page = rows.slice(0, limit);
    const lookahead = rows[limit];
    nextCursor = lookahead.id;
  }

  return { pulls: page, nextCursor };
};

export const pullRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // ---------------------------------------------------------------------
  // GET /api/pulls
  // ---------------------------------------------------------------------
  app.get(
    '/pulls',
    async (
      request: FastifyRequest<{
        Querystring: { limit?: string; cursor?: string };
      }>,
      reply: FastifyReply
    ) => {
      const limit = validateLimit(request.query.limit, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
      if (limit === null) {
        return handleError(
          reply,
          400,
          `Invalid limit. Must be an integer in [${MIN_LIMIT}, ${MAX_LIMIT}].`,
          'INVALID_PARAM'
        );
      }
      const cursor = validateCursor(request.query.cursor);
      if (cursor === null) {
        return handleError(reply, 400, 'Invalid cursor', 'INVALID_PARAM');
      }

      try {
        const cursorTuple = await resolveCursorTuple(cursor);
        const page = await listPullsPage({ limit, cursorTuple });
        return reply.code(200).send(
          buildEnvelope(page, {
            sources: [
              {
                label: 'PullCast indexer (BSC TokenVendingMachine PackOpened)',
                url: 'https://pullcast.xyz/api/pulls',
              },
            ],
          })
        );
      } catch (err) {
        console.error(`${LOG_PREFIX} list global failed:`, err);
        return handleError(
          reply,
          500,
          'Failed to load pulls',
          'PULLS_LIST_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  // ---------------------------------------------------------------------
  // GET /api/pulls/:id
  // ---------------------------------------------------------------------
  app.get(
    '/pulls/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      const pullId = validatePullId(request.params.id);
      if (pullId === null) {
        return handleError(reply, 400, 'Invalid pullId', 'INVALID_PARAM');
      }

      try {
        const pull = await prismaQuery.pull.findFirst({
          where: { id: pullId, deletedAt: null },
          select: PULL_PUBLIC_SELECT,
        });
        if (pull === null) {
          return handleNotFoundError(reply, 'Pull');
        }
        return reply.code(200).send(
          buildEnvelope(
            { pull },
            {
              sources: [
                {
                  label: 'PullCast indexer (BSC TokenVendingMachine PackOpened)',
                  url: `https://pullcast.xyz/api/pulls/${encodeURIComponent(pullId)}`,
                },
              ],
            }
          )
        );
      } catch (err) {
        console.error(`${LOG_PREFIX} get one failed id=${pullId}:`, err);
        return handleError(
          reply,
          500,
          'Failed to load pull',
          'PULL_GET_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  // ---------------------------------------------------------------------
  // GET /api/wallets/:address/pulls
  // ---------------------------------------------------------------------
  app.get(
    '/wallets/:address/pulls',
    async (
      request: FastifyRequest<{
        Params: { address: string };
        Querystring: { limit?: string; cursor?: string };
      }>,
      reply: FastifyReply
    ) => {
      const address = validateWalletAddress(request.params.address);
      if (address === null) {
        return handleError(
          reply,
          400,
          'Invalid wallet address. Expected 0x + 40 hex chars.',
          'INVALID_PARAM'
        );
      }

      const limit = validateLimit(request.query.limit, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
      if (limit === null) {
        return handleError(
          reply,
          400,
          `Invalid limit. Must be an integer in [${MIN_LIMIT}, ${MAX_LIMIT}].`,
          'INVALID_PARAM'
        );
      }
      const cursor = validateCursor(request.query.cursor);
      if (cursor === null) {
        return handleError(reply, 400, 'Invalid cursor', 'INVALID_PARAM');
      }

      try {
        const cursorTuple = await resolveCursorTuple(cursor);
        const page = await listPullsPage({
          buyerAddress: address,
          limit,
          cursorTuple,
        });
        return reply.code(200).send(
          buildEnvelope(page, {
            sources: [
              {
                label: 'PullCast indexer (BSC TokenVendingMachine PackOpened)',
                url: `https://pullcast.xyz/api/wallets/${encodeURIComponent(address)}/pulls`,
              },
            ],
          })
        );
      } catch (err) {
        console.error(`${LOG_PREFIX} list wallet failed addr=${address}:`, err);
        return handleError(
          reply,
          500,
          'Failed to load wallet pulls',
          'WALLET_PULLS_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  // ---------------------------------------------------------------------
  // GET /api/wallets/:address/summary
  //
  // Cheap aggregate over indexed Pull rows for the /$address gallery header.
  // Payload is flat (not nested) so the FE consumes `.data` directly.
  //
  // Fields:
  //   address       (echo, lower-cased)
  //   firstSeenAt   ISO 8601 of earliest Pull.pulledAtTimestamp, or null
  //   totalPulls    integer
  //   totalFmv      USD (dollars, float) — sum of fmvUsdCents / 100, or null
  //                 when no pulls have an fmvUsdCents.
  // ---------------------------------------------------------------------
  app.get(
    '/wallets/:address/summary',
    async (
      request: FastifyRequest<{ Params: { address: string } }>,
      reply: FastifyReply
    ) => {
      const address = validateWalletAddress(request.params.address);
      if (address === null) {
        return handleError(
          reply,
          400,
          'Invalid wallet address. Expected 0x + 40 hex chars.',
          'INVALID_PARAM'
        );
      }

      try {
        const [count, agg, first] = await Promise.all([
          prismaQuery.pull.count({
            where: { buyerAddress: address, deletedAt: null },
          }),
          prismaQuery.pull.aggregate({
            where: { buyerAddress: address, deletedAt: null },
            _sum: { fmvUsdCents: true },
          }),
          prismaQuery.pull.findFirst({
            where: { buyerAddress: address, deletedAt: null },
            orderBy: { pulledAtTimestamp: 'asc' },
            select: { pulledAtTimestamp: true },
          }),
        ]);

        const totalFmvCents = agg._sum.fmvUsdCents ?? null;
        const payload = {
          address,
          firstSeenAt: first?.pulledAtTimestamp.toISOString() ?? null,
          totalPulls: count,
          totalFmv:
            totalFmvCents !== null ? Math.round(totalFmvCents) / 100 : null,
        };

        return reply.code(200).send(
          buildEnvelope(payload, {
            sources: [
              {
                label: 'PullCast indexer (BSC TokenVendingMachine PackOpened)',
                url: `https://pullcast.xyz/api/wallets/${encodeURIComponent(address)}/summary`,
              },
            ],
          })
        );
      } catch (err) {
        console.error(`${LOG_PREFIX} summary failed addr=${address}:`, err);
        return handleError(
          reply,
          500,
          'Failed to load wallet summary',
          'WALLET_SUMMARY_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  done();
};


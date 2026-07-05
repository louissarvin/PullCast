/**
 * /api/users/* REST routes.
 *
 *   GET /api/users/:uuid    Public Renaiss user profile (favorited collectibles
 *                           + SBT badges) fetched live from
 *                           https://api.renaiss.xyz/v0/users/{id}.
 *
 * Constraints:
 *  - :uuid MUST be an RFC 4122 UUID. Wallet addresses, Discord IDs, usernames
 *    return 400 with a friendly error. There is no public address-to-UUID
 *    bridge on the Renaiss main API today; see memory/d8-user-odds-progress.md
 *    for the coaching question to Benjamin.
 *  - Per-IP rate limit via the atomic `consumeRateLimitToken` bucket
 *    `http:ip:<ip>:profile` (20 capacity, 20 refill / min).
 *  - Standard PullCast envelope: { data, sources, warnings, generated_at }
 *    wrapped in the top-level success/error envelope + `_disclosure` marker.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import { buildEnvelope } from '../utils/envelope.ts';
import { handleError } from '../utils/errorHandler.ts';
import { renaissApi, RenaissApiError } from '../lib/renaiss/index.ts';

const LOG_PREFIX = '[profile]';

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clientIp = (request: FastifyRequest): string => {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  return 'unknown';
};

const consumeIpToken = async (request: FastifyRequest): Promise<boolean> => {
  const key = `http:ip:${clientIp(request)}:profile`;
  return consumeRateLimitToken(key, 20, 20);
};

const renderTooManyRequests = (reply: FastifyReply): Promise<FastifyReply> => {
  return handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');
};

export const profileRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/:uuid',
    async (
      request: FastifyRequest<{ Params: { uuid: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const raw = request.params.uuid;
      if (typeof raw !== 'string' || !UUID_RX.test(raw.trim())) {
        return handleError(
          reply,
          400,
          'User id must be a UUID. Renaiss identifies users by UUID, not by wallet address or username.',
          'INVALID_UUID'
        );
      }
      const uuid = raw.trim().toLowerCase();

      try {
        const user = await renaissApi.getUser(uuid);
        const payload = {
          id: user.id,
          username: user.username,
          avatarUrl: user.avatarUrl,
          favoritedCollectibles: user.favoritedCollectibles,
          favoritedSBTs: user.favoritedSBTs,
        };
        return reply.code(200).send(
          buildEnvelope(payload, {
            sources: [
              {
                label: 'Renaiss main API GET /v0/users/{id}',
                url: `https://api.renaiss.xyz/v0/users/${uuid}`,
              },
            ],
            // Additional route-specific warning about live pass-through. The
            // BETA warning is added by buildEnvelope automatically.
            warnings: [
              {
                code: 'LIVE_PASSTHROUGH',
                message:
                  'Renaiss main API is in beta. Profile data is a live pass-through; PullCast does not cache or reshape.',
              },
            ],
          })
        );
      } catch (err) {
        if (err instanceof RenaissApiError) {
          if (err.status === 404) {
            return handleError(
              reply,
              404,
              'Renaiss user not found for that UUID.',
              'USER_NOT_FOUND'
            );
          }
          if (err.status !== null && err.status >= 400 && err.status < 500) {
            // Upstream 4xx (auth failures included) should not surface as a
            // client-fault code to our caller. Normalize to 502 so consumers
            // treat this as an upstream problem to retry.
            return handleError(
              reply,
              502,
              'Renaiss main API rejected the request.',
              'UPSTREAM_4XX'
            );
          }
        }
        console.error(`${LOG_PREFIX} getUser failed uuid=${uuid}:`, err);
        return handleError(
          reply,
          502,
          'Failed to fetch user profile from Renaiss main API.',
          'UPSTREAM_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  done();
};

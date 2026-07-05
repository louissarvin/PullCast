/**
 * /api/report REST route (M8 — Renaiss OS Index data-issue report).
 *
 *   POST /api/report
 *     body:
 *       {
 *         card?: { tokenId?, cert?, setName?, itemNo? },
 *         reason: string,          // required, 1-2000 chars
 *         evidence?: string,        // optional URL or note
 *         submitterHandle?: string  // optional Discord handle
 *       }
 *     200 -> standard PullCast envelope:
 *       {
 *         success: true,
 *         error: null,
 *         data: { received: true, reportId?: string },
 *         sources: [{ label: 'Renaiss OS Index (beta)', url: '.../v1/report' }],
 *         warnings: [{ code: 'BETA', message: '...' }],
 *         generated_at: <ISO>
 *       }
 *
 * Rate limit: per-IP 3 requests / min via `consumeRateLimitToken`. Tight so a
 * spam bot cannot pipe garbage into Renaiss's moderation queue.
 *
 * The route body is validated with a zod schema BEFORE calling the upstream
 * client. Any 4xx from upstream (422 validation, 429 rate limit) is surfaced
 * to the client as a mapped `handleError` code so the caller sees a stable
 * error surface rather than the raw Renaiss body.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { z } from 'zod';

import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import {
  IndexApiError,
  renaissIndex,
} from '../lib/renaiss-index/index.ts';
import { buildEnvelope, type EnvelopeSource } from '../utils/envelope.ts';
import { handleError } from '../utils/errorHandler.ts';

const LOG_PREFIX = '[report]';

const SOURCES: EnvelopeSource[] = [
  {
    label: 'Renaiss OS Index (beta)',
    url: 'https://api.renaissos.com/v1/report',
  },
];

/**
 * Route body validation. The public route accepts the PullCast-semantic shape
 * (matches `renaissIndex.reportIssue` signature). We are STRICT on the top
 * level to reject unknown keys at the boundary; the inner `card` object is
 * strict too so a mis-spelled key does not silently get dropped.
 */
const reportRouteBodySchema = z
  .object({
    card: z
      .object({
        tokenId: z.string().min(1).max(200).optional(),
        cert: z.string().min(1).max(64).optional(),
        setName: z.string().min(1).max(200).optional(),
        itemNo: z.string().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
    reason: z.string().min(1).max(2000),
    evidence: z.string().max(1000).optional(),
    submitterHandle: z.string().max(64).optional(),
  })
  .strict();

const clientIp = (request: FastifyRequest): string => {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  return 'unknown';
};

const consumeIpToken = async (request: FastifyRequest): Promise<boolean> => {
  // 3 tokens capacity, 3 refill / min — spam guard on a public POST that
  // fans out to a third-party moderation queue.
  return consumeRateLimitToken(`http:ip:${clientIp(request)}:report`, 3, 3);
};

const renderTooManyRequests = (reply: FastifyReply): Promise<FastifyReply> =>
  handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');

export const reportRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

    // Reject non-JSON bodies at the boundary. Fastify already parses JSON when
    // Content-Type is application/json; anything else is caller error.
    const contentType = request.headers['content-type'];
    if (
      typeof contentType !== 'string' ||
      !contentType.toLowerCase().includes('application/json')
    ) {
      return handleError(
        reply,
        400,
        'Content-Type must be application/json.',
        'INVALID_CONTENT_TYPE'
      );
    }

    const parsed = reportRouteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return handleError(
        reply,
        400,
        'Invalid report body.',
        'VALIDATION_ERROR',
        null,
        { issues: parsed.error.issues.slice(0, 5) }
      );
    }

    try {
      const result = await renaissIndex.reportIssue(parsed.data);
      const envelope = buildEnvelope(
        {
          received: true as const,
          ...(result.reportId ? { reportId: result.reportId } : {}),
        },
        { sources: SOURCES }
      );
      console.log(
        `${LOG_PREFIX} accepted ip=${clientIp(request)} reportId=${result.reportId ?? 'n/a'}`
      );
      return reply.code(200).send(envelope);
    } catch (err) {
      if (err instanceof IndexApiError) {
        // Map upstream 4xx to a stable error surface. We do NOT leak the raw
        // upstream body to the client.
        if (err.status === 422) {
          return handleError(
            reply,
            400,
            'Renaiss OS Index rejected the report body.',
            'VALIDATION_ERROR',
            err
          );
        }
        if (err.status === 429) {
          return handleError(
            reply,
            429,
            'Renaiss OS Index rate limit reached. Try again in a moment.',
            'UPSTREAM_RATE_LIMITED',
            err
          );
        }
        console.warn(
          `${LOG_PREFIX} upstream error status=${err.status} ip=${clientIp(request)}`
        );
        return handleError(
          reply,
          502,
          'Renaiss OS Index unreachable. Please try again in a moment.',
          'UPSTREAM_UNAVAILABLE',
          err
        );
      }
      console.error(`${LOG_PREFIX} unexpected error:`, err);
      return handleError(
        reply,
        500,
        'Unexpected internal error.',
        'INTERNAL_ERROR',
        err instanceof Error ? err : null
      );
    }
  });

  done();
};

/**
 * D6 AI track REST routes.
 *
 *  POST /api/explain  body { subject: 'cert' | 'token', value: string, question: string }
 *  POST /api/listing  body { subject: 'cert' | 'token', value: string }
 *
 * Per-IP rate limit on every endpoint via atomic `consumeRateLimitToken` with
 * bucket `http:ip:<ip>:ai` (capacity 10, refill 10/min). AI calls are more
 * expensive than /price so the bucket is roomy but not unlimited.
 *
 * Input validation reuses the D5 `paramValidators` for tokenId / cert.
 * The question string is bounded at 5-800 chars to match the slash command.
 *
 * All responses wrap the payload through the canonical envelope
 * (buildEnvelope) which embeds `_disclosure` inside `data` so the marker
 * cannot be dropped by transit normalizers. Refusals still come back with
 * `data.refused.reason` populated.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { explainAsk, listingSuggest } from '../lib/anthropic/index.ts';
import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import { buildEnvelope, SOURCE_RENAISS_MAIN, SOURCE_RENAISS_INDEX } from '../utils/envelope.ts';
import { handleError } from '../utils/errorHandler.ts';
import {
  validateCert,
  validateTokenId,
} from '../utils/paramValidators.ts';

const LOG_PREFIX = '[ai-routes]';

const QUESTION_MIN = 5;
const QUESTION_MAX = 800;

const clientIp = (request: FastifyRequest): string => {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  return 'unknown';
};

const consumeIpToken = async (request: FastifyRequest): Promise<boolean> => {
  // H-1: tightened from (10, 10) to (3, 3) to mirror the Discord-side
  // per-user AI budget. Combined with the daily global cap below this caps
  // Anthropic spend even under IP-rotation attack.
  const key = `http:ip:${clientIp(request)}:ai`;
  return consumeRateLimitToken(key, 3, 3);
};

/**
 * H-1: Global daily Anthropic budget guard. Capacity 500 requests / day with
 * zero refill — the bucket key encodes the UTC date so it naturally resets at
 * midnight. This is a hard ceiling independent of IP / botnet rotation; without
 * it a single attacker can burn the daily token budget in minutes.
 */
const consumeGlobalDailyToken = async (): Promise<boolean> => {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return consumeRateLimitToken(`anthropic:global:requests:${today}`, 500, 0);
};

/**
 * H-2: Cheap prompt-injection denylist. We refuse questions that try to
 * smuggle pseudo-system instructions or fake citation tokens. The real
 * defense is the XML wrap in prompts.ts; this is defense-in-depth at the
 * route boundary.
 */
const PROMPT_INJECTION_RE = /ignore previous|ignore prior|system prompt|<source-|\[source-|<\/source-/i;

const renderTooManyRequests = (reply: FastifyReply): Promise<FastifyReply> => {
  return handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');
};

interface ExplainBody {
  subject?: unknown;
  value?: unknown;
  question?: unknown;
}

interface ListingBody {
  subject?: unknown;
  value?: unknown;
}

const validateSubject = (raw: unknown): 'cert' | 'token' | null => {
  if (raw === 'cert' || raw === 'token') return raw;
  return null;
};

export const aiRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // -------------------------------------------------------------------
  // POST /api/explain
  // -------------------------------------------------------------------
  app.post(
    '/explain',
    async (
      request: FastifyRequest<{ Body: ExplainBody }>,
      reply: FastifyReply
    ) => {
      // H-1: global daily budget bucket BEFORE the per-IP bucket.
      if (!(await consumeGlobalDailyToken())) {
        return handleError(
          reply,
          429,
          'AI capacity exhausted for today',
          'AI_DAILY_BUDGET_EXHAUSTED'
        );
      }
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const body = (request.body ?? {}) as ExplainBody;
      const subject = validateSubject(body.subject);
      if (subject === null) {
        return handleError(
          reply,
          400,
          'subject must be "cert" or "token"',
          'INVALID_PARAM'
        );
      }
      if (typeof body.value !== 'string') {
        return handleError(reply, 400, 'value must be a string', 'INVALID_PARAM');
      }
      if (typeof body.question !== 'string') {
        return handleError(reply, 400, 'question must be a string', 'INVALID_PARAM');
      }
      const question = body.question.trim();
      if (question.length < QUESTION_MIN || question.length > QUESTION_MAX) {
        return handleError(
          reply,
          400,
          `question must be ${QUESTION_MIN}-${QUESTION_MAX} characters`,
          'INVALID_PARAM'
        );
      }
      // H-2: prompt-injection denylist at the route boundary.
      if (PROMPT_INJECTION_RE.test(question)) {
        return reply.code(200).send(
          buildEnvelope({
            text: '',
            sources: [],
            refused: { reason: 'unsafe-question' as const },
          })
        );
      }

      let normalizedValue: string;
      if (subject === 'cert') {
        const cert = validateCert(body.value);
        if (cert === null) {
          return handleError(
            reply,
            400,
            'Invalid cert. Format: PSA/BGS/CGC/SGC + 6-12 digits.',
            'INVALID_PARAM'
          );
        }
        normalizedValue = cert;
      } else {
        const tokenId = validateTokenId(body.value);
        if (tokenId === null) {
          return handleError(reply, 400, 'Invalid tokenId', 'INVALID_PARAM');
        }
        normalizedValue = tokenId;
      }

      try {
        const result =
          subject === 'cert'
            ? await explainAsk({
                subject: { kind: 'cert', cert: normalizedValue },
                question,
              })
            : await explainAsk({
                subject: { kind: 'tokenId', tokenId: normalizedValue },
                question,
              });
        const payload = {
          text: result.text,
          sources: result.sources,
          refused: result.refused ?? null,
        };
        return reply.code(200).send(
          buildEnvelope(payload, {
            sources: [SOURCE_RENAISS_MAIN, SOURCE_RENAISS_INDEX],
          })
        );
      } catch (err) {
        console.error(`${LOG_PREFIX} explain crashed:`, err);
        return handleError(
          reply,
          500,
          'AI service failed',
          'AI_ERROR',
          err instanceof Error ? err : null
        );
      }
    }
  );

  // -------------------------------------------------------------------
  // POST /api/listing
  // -------------------------------------------------------------------
  app.post(
    '/listing',
    async (
      request: FastifyRequest<{ Body: ListingBody }>,
      reply: FastifyReply
    ) => {
      // H-1: global daily budget bucket BEFORE the per-IP bucket.
      if (!(await consumeGlobalDailyToken())) {
        return handleError(
          reply,
          429,
          'AI capacity exhausted for today',
          'AI_DAILY_BUDGET_EXHAUSTED'
        );
      }
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const body = (request.body ?? {}) as ListingBody;
      const subject = validateSubject(body.subject);
      if (subject === null) {
        return handleError(
          reply,
          400,
          'subject must be "cert" or "token"',
          'INVALID_PARAM'
        );
      }
      if (typeof body.value !== 'string') {
        return handleError(reply, 400, 'value must be a string', 'INVALID_PARAM');
      }

      let normalizedValue: string;
      if (subject === 'cert') {
        const cert = validateCert(body.value);
        if (cert === null) {
          return handleError(
            reply,
            400,
            'Invalid cert. Format: PSA/BGS/CGC/SGC + 6-12 digits.',
            'INVALID_PARAM'
          );
        }
        normalizedValue = cert;
      } else {
        const tokenId = validateTokenId(body.value);
        if (tokenId === null) {
          return handleError(reply, 400, 'Invalid tokenId', 'INVALID_PARAM');
        }
        normalizedValue = tokenId;
      }

      try {
        const result =
          subject === 'cert'
            ? await listingSuggest({ cert: normalizedValue })
            : await listingSuggest({ tokenId: normalizedValue });
        return reply.code(200).send(
          buildEnvelope(
            {
              text: result.text,
              sources: result.sources,
              card: result.card,
              rangeLowUsdCents: result.rangeLowUsdCents,
              rangeMidUsdCents: result.rangeMidUsdCents,
              rangeHighUsdCents: result.rangeHighUsdCents,
              comparableCount: result.comparableCount,
              primaryFmvUsdCents: result.primaryFmvUsdCents,
              primarySource: result.primarySource,
              confidence: result.confidence,
              refused: result.refused ?? null,
            },
            { sources: [SOURCE_RENAISS_MAIN, SOURCE_RENAISS_INDEX] }
          )
        );
      } catch (err) {
        console.error(`${LOG_PREFIX} listing crashed:`, err);
        return handleError(
          reply,
          500,
          'AI service failed',
          'AI_ERROR',
          err instanceof Error ? err : null
        );
      }
    }
  );

  done();
};

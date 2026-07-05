/**
 * /api/price/* REST routes.
 *
 *  GET /api/price/token/:id    main API + (when serial present) Index API blend
 *  GET /api/price/cert/:cert   Index API cert lookup (cached)
 *  GET /api/price/search       Index API search (NOT cert-keyed; cache N/A)
 *
 * Per-IP rate limit on every endpoint via the atomic `consumeRateLimitToken`
 * bucket `http:ip:<ip>:price` (20 capacity, 20 refill per minute).
 *
 * Every response is wrapped with the canonical envelope (buildEnvelope) which
 * embeds `_disclosure` inside `data` so the marker is impossible to drop in
 * transit.
 *
 * The Index API path goes through `getOrFetchCert` (the cache helper), never
 * `renaissIndex.getGradedByCert` directly, per the D5 hard rule.
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
  parsePriceCents,
  RenaissApiError,
} from '../lib/renaiss/index.ts';
import {
  getOrFetchCert,
  IndexApiError,
  renaissIndex,
  lookupCardBridge,
} from '../lib/renaiss-index/index.ts';
import {
  getLastOnChainSale,
  BSC_CONTRACT_ADDRESSES,
  type LastOnChainSale,
} from '../lib/ethers/index.ts';
import { buildEnvelope, type EnvelopeSource } from '../utils/envelope.ts';
import { handleError } from '../utils/errorHandler.ts';
import {
  validateCert,
  validateLimit,
  validateTokenId,
} from '../utils/paramValidators.ts';

const LOG_PREFIX = '[price]';

const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 25;
const SEARCH_MIN_LIMIT = 1;

const VARIANCE_THRESHOLD = 0.2; // > 20% disagreement raises a `variancePct` flag in the response

/**
 * Best-effort client IP. `request.ip` already accounts for the trust-proxy
 * config; we coalesce to "unknown" to keep the bucket key non-empty even when
 * the IP cannot be resolved.
 */
const clientIp = (request: FastifyRequest): string => {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  return 'unknown';
};

const consumeIpToken = async (request: FastifyRequest): Promise<boolean> => {
  const key = `http:ip:${clientIp(request)}:price`;
  return consumeRateLimitToken(key, 20, 20);
};

const renderTooManyRequests = (reply: FastifyReply): Promise<FastifyReply> => {
  return handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');
};

// ---------------------------------------------------------------------------
// Renaiss main API card normalization (also used by the /price slash command).
// Kept local to avoid coupling the route to the discord command file.
// ---------------------------------------------------------------------------

interface NormalizedRenaissCard {
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  gradingCompany: string | null;
  grade: string | null;
  serial: string | null;
  language: string | null;
  imageUrl: string | null;
}

const stringOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

const normalizeRenaissCard = (raw: unknown): NormalizedRenaissCard => {
  const card = (raw ?? {}) as Record<string, unknown>;
  let serial = stringOrNull(card.serial);
  let gradingCompany = stringOrNull(card.gradingCompany);
  let grade = stringOrNull(card.grade);
  let language: string | null = null;

  const attrs = card.attributes;
  if (Array.isArray(attrs)) {
    for (const a of attrs) {
      if (typeof a !== 'object' || a === null) continue;
      const t =
        (a as { trait_type?: unknown }).trait_type ??
        (a as { trait?: unknown }).trait;
      const v = (a as { value?: unknown }).value;
      if (typeof t !== 'string') continue;
      const lower = t.toLowerCase();
      const valStr =
        typeof v === 'string' && v.length > 0
          ? v
          : typeof v === 'number' && Number.isFinite(v)
            ? String(v)
            : null;
      if (valStr === null) continue;
      if (
        serial === null &&
        (lower === 'serial' ||
          lower === 'cert' ||
          lower === 'cert number' ||
          lower === 'certification')
      ) {
        serial = valStr;
      } else if (
        gradingCompany === null &&
        (lower === 'grading company' || lower === 'grader')
      ) {
        gradingCompany = valStr;
      } else if (grade === null && lower === 'grade') {
        grade = valStr;
      } else if (language === null && lower === 'language') {
        language = valStr;
      }
    }
  }

  return {
    cardName: stringOrNull(card.name),
    setName: stringOrNull(card.setName),
    cardNumber: stringOrNull(card.cardNumber),
    gradingCompany,
    grade,
    serial,
    language,
    imageUrl: stringOrNull(card.imageUrl),
  };
};

const variancePct = (a: number, b: number): number => {
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return Math.abs(a - b) / denom;
};

export const priceRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // -------------------------------------------------------------------
  // GET /api/price/token/:id
  // -------------------------------------------------------------------
  app.get(
    '/token/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const tokenId = validateTokenId(request.params.id);
      if (tokenId === null) {
        return handleError(reply, 400, 'Invalid tokenId', 'INVALID_PARAM');
      }

      let card;
      try {
        card = await renaissApi.getCard(tokenId);
      } catch (err) {
        if (err instanceof RenaissApiError && err.status !== null && err.status >= 400 && err.status < 500) {
          return handleError(
            reply,
            404,
            `Token ${tokenId} not found`,
            'TOKEN_NOT_FOUND'
          );
        }
        console.error(`${LOG_PREFIX} renaissApi.getCard failed token=${tokenId}:`, err);
        return handleError(
          reply,
          502,
          'Renaiss main API unreachable',
          'UPSTREAM_UNAVAILABLE',
          err instanceof Error ? err : null
        );
      }

      const normalized = normalizeRenaissCard(card);
      const mainCents = parsePriceCents(
        (card as { fmvPriceInUSD?: unknown }).fmvPriceInUSD as
          | string
          | number
          | null
          | undefined
      );

      let indexCents: number | null = null;
      let confidence: 'prime' | 'high' | 'medium' | 'low' | null = null;
      let lastSaleAt: string | null = null;
      let bridgeSource: 'cert' | 'tuple' | 'renaiss-id' | null = null;
      const envelopeSources: EnvelopeSource[] = [
        {
          label: 'Renaiss main API',
          url: `https://api.renaiss.xyz/v0/collectibles/${encodeURIComponent(tokenId)}`,
        },
      ];

      let certUsed: string | null = null;
      const bridge = await lookupCardBridge({
        cert: normalized.serial !== null ? normalized.serial.toUpperCase() : null,
        tuple:
          normalized.setName !== null && normalized.cardNumber !== null
            ? {
                setName: normalized.setName,
                itemNo: normalized.cardNumber,
                language: normalized.language,
                gradingCompany: normalized.gradingCompany,
                grade: normalized.grade,
              }
            : null,
      });

      if (bridge.source !== null) {
        indexCents = bridge.fmvUsdCents;
        confidence = bridge.confidence;
        lastSaleAt = bridge.lastSaleAt;
        bridgeSource = bridge.source;
        if (bridge.source === 'cert' && normalized.serial !== null) {
          certUsed = normalized.serial.toUpperCase();
          envelopeSources.push({
            label: 'Renaiss Index API (cert)',
            url: `https://api.renaissos.com/v1/graded/${encodeURIComponent(certUsed)}`,
          });
        } else if (bridge.source === 'tuple') {
          envelopeSources.push({
            label: 'Renaiss OS Index (structural tuple)',
            url: 'https://api.renaissos.com/v1/index/item-by-no',
          });
          envelopeSources.push({
            label: 'Renaiss OS Index search (tuple fallback)',
            url: 'https://api.renaissos.com/v1/search',
          });
        }
      }

      const recommendedFmvCents =
        indexCents !== null ? indexCents : mainCents;
      const varianceHigh =
        mainCents !== null &&
        indexCents !== null &&
        variancePct(mainCents, indexCents) > VARIANCE_THRESHOLD;

      // Dual-mode resilience per file 15 §6.4: try to attach the most recent
      // on-chain Orderbook fill for `tokenId`. This is best-effort with a
      // hard 3s wall-clock timeout; RPC failure / no logs / timeout all
      // silently drop the field rather than fail the endpoint. When a fill
      // is found, we also register the BscScan URL as a corroborating source.
      let lastSaleOnChain: {
        priceUsdc: string;
        priceUsdcFormatted: string;
        paymentToken: string;
        txHash: string;
        blockNumber: number;
        timestamp: number;
        bscscanUrl: string;
      } | null = null;
      try {
        const onchain: LastOnChainSale | null = await Promise.race([
          getLastOnChainSale(tokenId),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
        ]);
        if (onchain !== null) {
          lastSaleOnChain = {
            priceUsdc: onchain.priceUsdc,
            priceUsdcFormatted: onchain.priceUsdcFormatted,
            paymentToken: onchain.paymentToken,
            txHash: onchain.txHash,
            blockNumber: onchain.blockNumber,
            timestamp: onchain.timestamp,
            bscscanUrl: `https://bscscan.com/tx/${onchain.txHash}`,
          };
          envelopeSources.push({
            label: 'Orderbook TradeExecutedV2 (on-chain BSC)',
            url: `https://bscscan.com/address/${BSC_CONTRACT_ADDRESSES.orderbook}#events`,
          });
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} on-chain lastSale lookup failed token=${tokenId}:`, err);
        // Silent fallback per dual-mode contract.
      }

      const payload = {
        tokenId,
        cert: certUsed,
        cardName: normalized.cardName,
        setName: normalized.setName,
        cardNumber: normalized.cardNumber,
        gradingCompany: normalized.gradingCompany,
        grade: normalized.grade,
        serial: normalized.serial,
        imageUrl: normalized.imageUrl,
        mainApiFmvUsdCents: mainCents,
        indexApiFmvUsdCents: indexCents,
        recommendedFmvUsdCents: recommendedFmvCents,
        confidence,
        lastSaleAt,
        lastSaleOnChain,
        variancePctOver20: varianceHigh,
        hasGradedCert: certUsed !== null,
        indexBridgeSource: bridgeSource,
      };

      return reply
        .code(200)
        .send(buildEnvelope(payload, { sources: envelopeSources }));
    }
  );

  // -------------------------------------------------------------------
  // GET /api/price/cert/:cert
  // -------------------------------------------------------------------
  app.get(
    '/cert/:cert',
    async (
      request: FastifyRequest<{ Params: { cert: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const cert = validateCert(request.params.cert);
      if (cert === null) {
        return handleError(
          reply,
          400,
          'Invalid cert. Format: PSA/BGS/CGC/SGC + 6-12 digits.',
          'INVALID_PARAM'
        );
      }

      let lookup;
      try {
        lookup = await getOrFetchCert(cert);
      } catch (err) {
        if (err instanceof IndexApiError) {
          console.warn(`${LOG_PREFIX} cert lookup failed cert=${cert} status=${err.status}`);
        } else {
          console.error(`${LOG_PREFIX} cert lookup unexpected cert=${cert}:`, err);
        }
        return handleError(
          reply,
          502,
          'Renaiss Index API unreachable',
          'UPSTREAM_UNAVAILABLE',
          err instanceof Error ? err : null
        );
      }

      if (!lookup.found) {
        // 404 preserves the pre-existing shape (error, not envelope) since the
        // canonical envelope is for successful responses. handleError yields
        // the same {success:false, error, data:null, timestamp} error shape
        // used elsewhere.
        return handleError(
          reply,
          404,
          `No grading record for ${cert}.`,
          'CERT_NOT_FOUND',
          null,
          { reason: lookup.reason ?? null }
        );
      }

      const cardPayload = lookup.card ?? {};
      const indexCents = parsePriceCents(
        (cardPayload as { priceUsdCents?: number | null }).priceUsdCents ?? null
      );

      const payload = {
        cert,
        found: true as const,
        cardName: stringOrNull(cardPayload.name),
        setName: stringOrNull(cardPayload.setName),
        cardNumber: stringOrNull(cardPayload.cardNumber),
        gradingCompany: stringOrNull(cardPayload.gradingCompany),
        grade: stringOrNull(cardPayload.grade),
        imageUrl: stringOrNull(cardPayload.imageUrl),
        indexApiFmvUsdCents: indexCents,
        recommendedFmvUsdCents: indexCents,
        confidence:
          (cardPayload.confidence ?? null) as 'prime' | 'high' | 'medium' | 'low' | null,
        lastSaleAt: stringOrNull(cardPayload.lastSaleAt),
        certImages: lookup.certImages ?? null,
      };

      return reply.code(200).send(
        buildEnvelope(payload, {
          sources: [
            {
              label: 'Renaiss Index API',
              url: `https://api.renaissos.com/v1/graded/${encodeURIComponent(cert)}`,
            },
          ],
        })
      );
    }
  );

  // -------------------------------------------------------------------
  // GET /api/price/search?q=...&limit=10
  // -------------------------------------------------------------------
  app.get(
    '/search',
    async (
      request: FastifyRequest<{ Querystring: { q?: string; limit?: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) return renderTooManyRequests(reply);

      const q =
        typeof request.query.q === 'string' ? request.query.q.trim() : '';
      if (q.length === 0 || q.length > 200) {
        return handleError(
          reply,
          400,
          'Query `q` is required (1-200 chars).',
          'INVALID_PARAM'
        );
      }

      const limit = validateLimit(
        request.query.limit,
        SEARCH_DEFAULT_LIMIT,
        SEARCH_MIN_LIMIT,
        SEARCH_MAX_LIMIT
      );
      if (limit === null) {
        return handleError(
          reply,
          400,
          `Invalid limit. Must be an integer in [${SEARCH_MIN_LIMIT}, ${SEARCH_MAX_LIMIT}].`,
          'INVALID_PARAM'
        );
      }

      try {
        const results = await renaissIndex.searchCards(q, { limit });
        return reply.code(200).send(
          buildEnvelope(
            { query: q, limit, results },
            {
              sources: [
                {
                  label: 'Renaiss Index API card search',
                  url: 'https://api.renaissos.com/v1/search',
                },
              ],
            }
          )
        );
      } catch (err) {
        if (err instanceof IndexApiError) {
          console.warn(`${LOG_PREFIX} search failed q="${q}" status=${err.status}`);
        } else {
          console.error(`${LOG_PREFIX} search unexpected q="${q}":`, err);
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


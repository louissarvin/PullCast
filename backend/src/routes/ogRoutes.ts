/**
 * OG share-card image endpoint.
 *
 *  GET /og/:pullId            returns the share-card PNG for a given Pull.
 *  query ?variant=psa|bgs|cgc|sgc|generic   optional variant override.
 *
 * The endpoint lives at the root (no `/api` prefix) so social platforms get
 * clean preview URLs (e.g. https://pullcast.xyz/og/<id>).
 *
 * Stampede protection: the render delegates to `getOrRenderShareCard` from D4,
 * which has an in-memory inFlight Map keyed by (pullId, variant). 50 concurrent
 * link previews trigger ONE render.
 *
 * Per architecture risk 5: response is `Cache-Control: public, max-age=3600,
 * immutable` so CDN + browser cache absorb most repeats.
 *
 * Render failure does NOT 500. We return a tiny 1200x630 placeholder PNG with
 * the disclosure watermark so social previews never look broken.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { prismaQuery } from '../lib/prisma.ts';
import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import { getOrRenderShareCard } from '../lib/discord/share-card-poster.ts';
import { renderShareCard } from '../lib/share-card/index.ts';
import type { ShareCardStyleVariant } from '../lib/share-card/index.ts';
import { handleError, handleNotFoundError } from '../utils/errorHandler.ts';
import { validatePullId } from '../utils/paramValidators.ts';

const LOG_PREFIX = '[og]';

const VALID_VARIANTS: ReadonlySet<ShareCardStyleVariant> = new Set([
  'psa',
  'bgs',
  'cgc',
  'generic',
]);

const parseVariant = (
  raw: string | undefined
): ShareCardStyleVariant | undefined => {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const lower = raw.toLowerCase();
  // SGC is renderer-side treated as generic; accept it as an alias.
  if (lower === 'sgc') return 'generic';
  if (VALID_VARIANTS.has(lower as ShareCardStyleVariant)) {
    return lower as ShareCardStyleVariant;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Placeholder PNG cache. Generated lazily on first failure, cached in-memory.
// ---------------------------------------------------------------------------

let placeholderPng: Buffer | null = null;
let placeholderPromise: Promise<Buffer> | null = null;

/**
 * Render a tiny placeholder share-card via the existing renderer.
 *
 * We re-use `renderShareCard` (not a raw PNG ImageMagick blob) so the
 * placeholder is visually consistent with the rest of the gallery and carries
 * the disclosure watermark through the same code path. Cached after first
 * render so subsequent failures do not pay the render cost.
 */
const ensurePlaceholder = async (): Promise<Buffer> => {
  if (placeholderPng !== null) return placeholderPng;
  if (placeholderPromise !== null) return placeholderPromise;

  placeholderPromise = (async (): Promise<Buffer> => {
    try {
      const rendered = await renderShareCard({
        cardName: 'Pull preview unavailable',
        setName: '',
        cardNumber: '',
        imageUrl: '',
        packLabel: 'PullCast',
        packPriceUsdCents: 0,
        fmvUsdCents: null,
        netGainUsdCents: null,
        gradingCompany: null,
        grade: null,
        serial: null,
        buyerAddress: '0x0000000000000000000000000000000000000000',
        pulledAt: new Date(),
        tier: null,
        styleVariant: 'generic',
      });
      placeholderPng = rendered.png;
      return rendered.png;
    } catch (err) {
      // Last resort: a 1x1 transparent PNG so the route never hangs / 500s.
      console.error(`${LOG_PREFIX} placeholder render failed:`, err);
      const TRANSPARENT_PIXEL = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64'
      );
      placeholderPng = TRANSPARENT_PIXEL;
      return TRANSPARENT_PIXEL;
    } finally {
      placeholderPromise = null;
    }
  })();

  return placeholderPromise;
};

/**
 * Pre-warm the placeholder. Called from index.ts.start so the first failure
 * does not pay the render cost. Best-effort: failures are logged and ignored.
 */
export const warmOgPlaceholder = async (): Promise<void> => {
  try {
    await ensurePlaceholder();
    console.log(`${LOG_PREFIX} placeholder warmed`);
  } catch (err) {
    console.warn(`${LOG_PREFIX} placeholder warm failed:`, err);
  }
};

export const ogRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/og/:pullId',
    async (
      request: FastifyRequest<{
        Params: { pullId: string };
        Querystring: { variant?: string };
      }>,
      reply: FastifyReply
    ) => {
      // M-3: per-IP render-bomb guard. 30/min is generous for legitimate
      // social-preview unfurls + repeat human visits, tight enough to stop
      // an enumerated-pullId Satori storm.
      const ip = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
      const ipAllowed = await consumeRateLimitToken(`http:ip:${ip}:og`, 30, 30);
      if (!ipAllowed) {
        return handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');
      }

      const pullId = validatePullId(request.params.pullId);
      if (pullId === null) {
        return handleError(reply, 400, 'Invalid pullId', 'INVALID_PARAM');
      }

      // 1. Verify the Pull exists (and is not soft-deleted) so we never render
      //    for a missing id. Cheap select; uses the primary key index.
      let exists;
      try {
        exists = await prismaQuery.pull.findFirst({
          where: { id: pullId, deletedAt: null },
          select: { id: true },
        });
      } catch (err) {
        console.error(`${LOG_PREFIX} pull lookup failed id=${pullId}:`, err);
        return handleError(
          reply,
          500,
          'Failed to load pull',
          'PULL_LOOKUP_FAILED',
          err instanceof Error ? err : null
        );
      }

      if (exists === null) {
        return handleNotFoundError(reply, 'Pull');
      }

      const variant = parseVariant(request.query.variant);

      // 2. Try the stampede-cached renderer. Any failure falls back to the
      //    in-memory placeholder so social previews never break.
      let buffer: Buffer;
      try {
        const card = await getOrRenderShareCard(pullId, variant);
        buffer = card.buffer;
      } catch (err) {
        console.error(`${LOG_PREFIX} render failed pull=${pullId}:`, err);
        buffer = await ensurePlaceholder();
      }

      // 3. Aggressive CDN-friendly cache headers.
      return reply
        .type('image/png')
        .header('Cache-Control', 'public, max-age=3600, immutable')
        .send(buffer);
    }
  );

  done();
};


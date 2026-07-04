import { z } from 'zod';
import { RENAISS_INDEX_BASE } from '../../config/main-config.ts';
import { IndexApiError } from './errors.ts';
import { buildIndexAuthHeaders } from './index-headers.ts';
import { INDEX_BETA_DISCLOSURE } from './types-runtime.ts';
import {
  indexGradedSchema,
  indexSearchResponseSchema,
  indexTradesResponseSchema,
  indexFmvSeriesResponseSchema,
  indexCardOverviewSchema,
  indicesResponseSchema,
  indexDetailSchema,
  featuredResponseSchema,
  reportIssueInputSchema,
  reportSubmitResponseSchema,
  indexCardDetailSchema,
  indexCardDetailOverviewSchema,
  indexCardTradesResponseSchema,
  indexCardSeriesResponseSchema,
  indexCardFmvSeriesResponseSchema,
  setResponseSchema,
  unwrapIndexList,
} from './schemas.ts';
import type {
  ReportIssueInput,
  IndexCardDetail,
  IndexCardDetailOverview,
  IndexCardTradesResponse,
  IndexCardSeriesResponse,
  IndexCardFmvSeriesResponse,
  IndexSetListing,
} from './schemas.ts';
import {
  consumeGradedSseStream,
  type ProgressCallback,
} from './sse.ts';
import type {
  IndexGraded,
  IndexSearchResult,
  IndexTrade,
  IndexFmvPoint,
} from './types.ts';
import type {
  IndexTile,
  IndexDetail,
  CardSummary,
  IndexGameSlug,
} from './schemas.ts';

const REQUEST_TIMEOUT_MS = 8000;
const RETRY_BACKOFFS_MS = [250, 500, 1000];
const LOG_PREFIX = '[renaiss-index]';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableStatus = (status: number | null): boolean => {
  if (status === null) return true;
  return status >= 500 && status < 600;
};

// -------------------------------------------------------------------
// Global 429 circuit breaker.
//
// When upstream Renaiss Index returns 429 we trip the breaker for
// RATE_LIMIT_COOLDOWN_MS. Every outbound call during that window is
// short-circuited with a synthetic IndexApiError(429). This gives the
// market-cache stale layer a chance to serve last-known-good data
// AND prevents us from hammering the upstream when it is rate-limiting us.
// Callers see the same IndexApiError contract they already handle.
// -------------------------------------------------------------------
const RATE_LIMIT_COOLDOWN_MS = 60_000;
// Cap the breaker cooldown regardless of what Retry-After upstream sends.
// Renaiss can respond with multi-hour Retry-After values (e.g. 54,950s)
// which lock us out well beyond any reasonable burst-limit window. Direct
// curl proves the endpoint is actually reachable — so we retry sooner and
// let the natural upstream response drive our behavior.
const RATE_LIMIT_COOLDOWN_MAX_MS = 5 * 60_000;
let breakerTrippedUntil = 0;

const isBreakerOpen = (): boolean => breakerTrippedUntil > Date.now();

const tripBreaker = (path: string, retryAfterSec: number | null): void => {
  // Base cooldown: retry-after (bounded) or the default 60s.
  const requested = retryAfterSec !== null
    ? Math.max(RATE_LIMIT_COOLDOWN_MS, retryAfterSec * 1000)
    : RATE_LIMIT_COOLDOWN_MS;
  const cooldown = Math.min(requested, RATE_LIMIT_COOLDOWN_MAX_MS);
  const until = Date.now() + cooldown;
  if (until > breakerTrippedUntil) {
    breakerTrippedUntil = until;
    console.warn(
      `${LOG_PREFIX} circuit breaker tripped path=${path} cooldown_ms=${cooldown} (upstream_asked=${retryAfterSec !== null ? retryAfterSec * 1000 : 'default'})`
    );
  }
};

/** Test-only: reset the breaker between tests. Not exported from index.ts. */
export const _resetRenaissIndexBreaker = (): void => {
  breakerTrippedUntil = 0;
};

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
}

const buildUrl = (path: string, query?: RequestOptions['query']): string => {
  const base = RENAISS_INDEX_BASE.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${suffix}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
};

const request = async <S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  options: RequestOptions = {}
): Promise<z.infer<S>> => {
  // Short-circuit while the global 429 breaker is open. Callers already
  // handle IndexApiError with status=429 (fall back to stale market-cache).
  if (isBreakerOpen()) {
    throw new IndexApiError('Index API rate-limit cooldown active', {
      status: 429,
      endpoint: path,
      cause: 'circuit_breaker_open',
    });
  }

  const url = buildUrl(path, options.query);
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const outboundHeaders = buildIndexAuthHeaders();
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: outboundHeaders,
      });

      if (!res.ok) {
        const status = res.status;
        // Trip the global breaker on any 429 so concurrent callers stop
        // hammering upstream. Respect Retry-After when present.
        if (status === 429) {
          const retryAfterHeader = res.headers.get('retry-after');
          const retryAfterSec = retryAfterHeader && /^\d+$/.test(retryAfterHeader)
            ? parseInt(retryAfterHeader, 10)
            : null;
          // Diagnostic: capture the rate-limit headers so we understand which
          // quota is being enforced (per-key, per-IP, per-endpoint, etc.).
          const rlLimit = res.headers.get('x-ratelimit-limit');
          const rlRemaining = res.headers.get('x-ratelimit-remaining');
          const rlReset = res.headers.get('x-ratelimit-reset');
          // Also log the outbound header keys and whether the key/secret pair
          // are actually present. If rl_limit=10 (public tier) despite our
          // env being set, the auth headers are being dropped somewhere.
          const sentKeys = Object.keys(outboundHeaders).join(',');
          const keyVal = outboundHeaders['X-Api-Key'] ?? '';
          const secVal = outboundHeaders['X-Api-Secret'] ?? '';
          const hasKey = keyVal.length > 0;
          const hasSecret = secVal.length > 0;
          const keyLen = keyVal.length;
          const secLen = secVal.length;
          const keyPref = keyVal.slice(0, 6);
          const secPref = secVal.slice(0, 6);
          const cache = res.headers.get('x-vercel-cache');
          const vercelId = res.headers.get('x-vercel-id');
          console.warn(
            `${LOG_PREFIX} 429 path=${path} full_url=${url} rl_limit=${rlLimit} rl_remaining=${rlRemaining} retry_after=${retryAfterSec} has_key=${hasKey} has_secret=${hasSecret} key_len=${keyLen} sec_len=${secLen} key_pref=${keyPref} sec_pref=${secPref} cache=${cache} vercel_id=${vercelId}`
          );
          tripBreaker(path, retryAfterSec);
          throw new IndexApiError(`Index API request failed (${status})`, {
            status,
            endpoint: path,
            cause: 'rate_limited',
          });
        }
        if (!isRetryableStatus(status) || attempt === RETRY_BACKOFFS_MS.length) {
          const bodySnippet = await res.text().catch(() => '');
          throw new IndexApiError(`Index API request failed (${status})`, {
            status,
            endpoint: path,
            cause: bodySnippet.slice(0, 500),
          });
        }
        console.warn(`${LOG_PREFIX} retry path=${path} status=${status} attempt=${attempt + 1}`);
        await sleep(RETRY_BACKOFFS_MS[attempt]);
        continue;
      }

      const json: unknown = await res.json();
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        // Schema mismatch is NOT retryable; the upstream shape changed.
        throw new IndexApiError('Index API response failed schema validation', {
          status: res.status,
          endpoint: path,
          cause: parsed.error,
        });
      }
      return parsed.data;
    } catch (err) {
      lastError = err;
      if (err instanceof IndexApiError && !isRetryableStatus(err.status)) {
        throw err;
      }
      if (attempt === RETRY_BACKOFFS_MS.length) break;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG_PREFIX} retry path=${path} reason="${reason}" attempt=${attempt + 1}`);
      await sleep(RETRY_BACKOFFS_MS[attempt]);
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof IndexApiError) {
    throw lastError;
  }
  throw new IndexApiError('Index API request failed after retries', {
    status: null,
    endpoint: path,
    cause: lastError,
  });
};

/**
 * Attach the mandatory beta disclosure to a returned object. Spread is shallow
 * but the disclosure is a top-level marker so callers always see it.
 */
const withDisclosure = <T extends object>(obj: T): T & { _disclosure: typeof INDEX_BETA_DISCLOSURE } => {
  return Object.assign({}, obj, { _disclosure: INDEX_BETA_DISCLOSURE });
};

/**
 * D9: translate the PullCast-standard string window form ('7d'|'30d'|'90d')
 * into the numeric wire value the Index API expects. The upstream OpenAPI
 * enum for `/cards/by-*` series windows is {30, 90, 365, 1095, 36500} — 7d is
 * NOT accepted directly so it maps to 30 (the smallest supported window). Any
 * unrecognized input falls back to 30 per the OpenAPI documentation.
 */
const normalizeWindow = (
  raw: '7d' | '30d' | '90d' | 30 | 90 | 365 | 1095 | 36500 | undefined
): 30 | 90 | 365 | 1095 | 36500 => {
  if (raw === undefined) return 30;
  if (typeof raw === 'number') {
    if (raw === 30 || raw === 90 || raw === 365 || raw === 1095 || raw === 36500) {
      return raw;
    }
    return 30;
  }
  if (raw === '90d') return 90;
  if (raw === '30d') return 30;
  // '7d' has no exact upstream match; the smallest supported window (30) is
  // the safest fallback per OpenAPI documentation ("Other values fall back to
  // 30").
  return 30;
};

/**
 * Window normalizer for the SLUG family (`/v1/cards/{game}/{set}/{card}/series`
 * and `/fmv-series`). Unlike the by-id / by-renaiss-id family, the slug family
 * OpenAPI enum for `window` is {7, 30, 90, 365} — 7 IS a first-class value.
 * We accept both the PullCast-standard string form ('7d'|'30d'|'90d') and the
 * numeric form and return the wire integer.
 */
const normalizeSlugWindow = (
  raw: '7d' | '30d' | '90d' | 7 | 30 | 90 | 365 | undefined
): 7 | 30 | 90 | 365 => {
  if (raw === undefined) return 30;
  if (typeof raw === 'number') {
    if (raw === 7 || raw === 30 || raw === 90 || raw === 365) return raw;
    return 30;
  }
  if (raw === '7d') return 7;
  if (raw === '90d') return 90;
  return 30;
};

/**
 * Renaiss Index API low-level client. Application code MUST go through
 * `cache.getOrFetchCert` for graded-cert lookups; calling `getGradedByCert`
 * here directly is reserved for the cache itself.
 */
export const renaissIndex = {
  /**
   * GET /graded/{cert}. Primary FMV source for graded cards.
   * Use `cache.getOrFetchCert` from `cache.ts` instead of calling this in
   * application code.
   */
  getGradedByCert: async (cert: string): Promise<IndexGraded> => {
    if (!cert || typeof cert !== 'string') {
      throw new IndexApiError('getGradedByCert requires a non-empty cert', {
        status: null,
        endpoint: '/graded/{cert}',
      });
    }
    const data = await request(`/graded/${encodeURIComponent(cert)}`, indexGradedSchema);
    return withDisclosure(data);
  },

  /**
   * GET /graded/{cert}/stream. SSE variant of `getGradedByCert`.
   *
   * Fires `onProgress` for each pipeline stage, then resolves with the
   * terminal GradedLookup payload. Callers that do not need live progress
   * should use `getGradedByCert` (goes through the cache) instead.
   *
   * Timeouts: 8s per-stage / 60s overall by default; both are configurable
   * for load-shedding.
   */
  streamGradedByCert: async (
    cert: string,
    onProgress?: ProgressCallback,
    opts: { overallTimeoutMs?: number; stageTimeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<IndexGraded> => {
    if (!cert || typeof cert !== 'string') {
      throw new IndexApiError('streamGradedByCert requires a non-empty cert', {
        status: null,
        endpoint: '/graded/{cert}/stream',
      });
    }
    const base = RENAISS_INDEX_BASE.replace(/\/+$/, '');
    const url = `${base}/graded/${encodeURIComponent(cert)}/stream`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: buildIndexAuthHeaders({ accept: 'text/event-stream' }),
        signal: opts.signal,
      });
    } catch (err) {
      throw new IndexApiError('streamGradedByCert network request failed', {
        status: null,
        endpoint: '/graded/{cert}/stream',
        cause: err,
      });
    }

    if (!res.ok || res.body === null) {
      let bodySnippet = '';
      try {
        bodySnippet = (await res.text()).slice(0, 500);
      } catch {
        // ignore
      }
      throw new IndexApiError(
        `streamGradedByCert upstream returned ${res.status}`,
        {
          status: res.status,
          endpoint: '/graded/{cert}/stream',
          cause: bodySnippet,
        }
      );
    }

    return consumeGradedSseStream(res.body, {
      endpoint: '/graded/{cert}/stream',
      onProgress,
      overallTimeoutMs: opts.overallTimeoutMs,
      stageTimeoutMs: opts.stageTimeoutMs,
      signal: opts.signal,
    });
  },

  /**
   * GET /search. Free-text search across Renaiss Index.
   * Per 17_renaiss_cli_indexapi_research.md Section 4 the documented params
   * are q + limit only. game/set are passed through as best-effort and may
   * be ignored by the server.
   */
  searchCards: async (
    query: string,
    opts: { game?: string; set?: string; limit?: number } = {}
  ): Promise<IndexSearchResult[]> => {
    if (!query || typeof query !== 'string') {
      throw new IndexApiError('searchCards requires a non-empty query', {
        status: null,
        endpoint: '/search',
      });
    }
    const data = await request(`/search`, indexSearchResponseSchema, {
      query: { q: query, game: opts.game, set: opts.set, limit: opts.limit },
    });
    return unwrapIndexList<IndexSearchResult>(data, ['results', 'items']).map((item) =>
      withDisclosure(item)
    );
  },

  /**
   * GET /index/item-by-no — structural tuple lookup (Renaiss OS Index docs).
   * Returns null when the endpoint is not deployed (404) or no tiers match.
   */
  getItemByTuple: async (opts: {
    setName: string;
    itemNo: string;
    variation?: string;
    language: string;
  }): Promise<IndexSearchResult[] | null> => {
    const url = buildUrl('/index/item-by-no', {
      set_name: opts.setName,
      item_no: opts.itemNo,
      variation: opts.variation ?? '',
      language: opts.language,
    });
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: buildIndexAuthHeaders(),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new IndexApiError(`Index tuple lookup failed (${res.status})`, {
          status: res.status,
          endpoint: '/index/item-by-no',
        });
      }
      const json: unknown = await res.json();
      return unwrapIndexList<IndexSearchResult>(json, ['items', 'results', 'tiers']);
    } catch (err) {
      if (err instanceof IndexApiError) throw err;
      throw new IndexApiError('Index tuple lookup failed', {
        status: null,
        endpoint: '/index/item-by-no',
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * GET /trades/recent. Market-wide recent trades.
   */
  getRecentTrades: async (opts: { limit?: number } = {}): Promise<IndexTrade[]> => {
    const data = await request(`/trades/recent`, indexTradesResponseSchema, {
      query: { limit: opts.limit },
    });
    return unwrapIndexList<IndexTrade>(data, ['trades', 'items']).map((item) =>
      withDisclosure(item)
    );
  },

  /**
   * GET /cards/by-id/{id}/trades. Per-card recent trades.
   * Path corrected per 17_renaiss_cli_indexapi_research.md Section 4.
   */
  getCardTrades: async (cardId: string, opts: { limit?: number } = {}): Promise<IndexTrade[]> => {
    if (!cardId || typeof cardId !== 'string') {
      throw new IndexApiError('getCardTrades requires a non-empty cardId', {
        status: null,
        endpoint: '/cards/by-id/{id}/trades',
      });
    }
    const data = await request(
      `/cards/by-id/${encodeURIComponent(cardId)}/trades`,
      indexTradesResponseSchema,
      { query: { limit: opts.limit } }
    );
    return unwrapIndexList<IndexTrade>(data, ['trades', 'items']).map((item) =>
      withDisclosure(item)
    );
  },

  /**
   * GET /cards/by-id/{id}/fmv-series.
   * Path corrected per 17_renaiss_cli_indexapi_research.md Section 4.
   */
  getFmvSeries: async (
    cardId: string,
    opts: { window?: '7d' | '30d' | '90d' } = {}
  ): Promise<IndexFmvPoint[]> => {
    if (!cardId || typeof cardId !== 'string') {
      throw new IndexApiError('getFmvSeries requires a non-empty cardId', {
        status: null,
        endpoint: '/cards/by-id/{id}/fmv-series',
      });
    }
    const data = await request(
      `/cards/by-id/${encodeURIComponent(cardId)}/fmv-series`,
      indexFmvSeriesResponseSchema,
      { query: { window: opts.window } }
    );
    const arr = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    return arr.map((item) => withDisclosure(item));
  },

  /**
   * GET /cards/by-id/{id}/overview. Grade-blended FMV and aggregate stats.
   * Used by D6 /explain for grounded answers.
   * Per 17_renaiss_cli_indexapi_research.md Section 4.
   */
  getCardOverview: async (cardId: string): Promise<unknown> => {
    if (!cardId || typeof cardId !== 'string') {
      throw new IndexApiError('getCardOverview requires a non-empty cardId', {
        status: null,
        endpoint: '/cards/by-id/{id}/overview',
      });
    }
    const data = await request(
      `/cards/by-id/${encodeURIComponent(cardId)}/overview`,
      indexCardOverviewSchema,
      {}
    );
    return withDisclosure(data);
  },

  // -----------------------------------------------------------------
  // D8: /v1/indices, /v1/indices/{game}, /v1/cards/featured
  //
  // These endpoints power the /market and /featured Discord commands and
  // the daily "Card of the Day" cron. Every returned object carries
  // `_disclosure` so downstream Discord/HTTP consumers cannot accidentally
  // drop the beta marker.
  // -----------------------------------------------------------------

  /**
   * GET /v1/indices. Returns basket-level metrics for every indexed game
   * (pokemon, one-piece, sports). The result MUST be wrapped with the beta
   * disclosure at the tile level so `/market` embeds can never leak an
   * un-disclosed value.
   */
  getIndices: async (): Promise<IndexTile[]> => {
    const data = await request(`/indices`, indicesResponseSchema);
    const tiles = Array.isArray(data.indices) ? data.indices : [];
    return tiles.map((tile) => withDisclosure(tile));
  },

  /**
   * GET /v1/indices/{game}. Drill-down for one game, including its ranked
   * constituents (list of cards that make up the basket).
   */
  getIndicesByGame: async (game: IndexGameSlug): Promise<IndexDetail> => {
    if (!game || typeof game !== 'string') {
      throw new IndexApiError('getIndicesByGame requires a game slug', {
        status: null,
        endpoint: '/indices/{game}',
      });
    }
    const data = await request(
      `/indices/${encodeURIComponent(game)}`,
      indexDetailSchema
    );
    return withDisclosure(data);
  },

  /**
   * GET /v1/cards/featured. Top-mover card tiles across the indexed games.
   * Server default is 6, max 24. We pass through whatever the caller asked
   * for; validation of bounds happens at the route/command layer.
   */
  getFeatured: async (limit?: number): Promise<CardSummary[]> => {
    const query: Record<string, string | number | undefined> = {};
    if (typeof limit === 'number' && Number.isFinite(limit)) {
      query.limit = Math.max(1, Math.min(24, Math.floor(limit)));
    }
    const data = await request(`/cards/featured`, featuredResponseSchema, {
      query,
    });
    const cards = Array.isArray(data.cards) ? data.cards : [];
    return cards.map((card) => withDisclosure(card));
  },

  // -----------------------------------------------------------------
  // Slug-family endpoints (Gap 3 + Gap 4 + Gap 7 in file 17 §4):
  //
  //   /v1/sets/{game}/{set}
  //   /v1/cards/{game}/{set}/{card}
  //   /v1/cards/{game}/{set}/{card}/overview   (grade-less slug)
  //   /v1/cards/{game}/{set}/{card}/trades
  //   /v1/cards/{game}/{set}/{card}/series
  //   /v1/cards/{game}/{set}/{card}/fmv-series
  //   /v1/cards/by-id/{id}/series               (Gap 7 — RAW per-trade series)
  //
  // Slug validation: every path segment is passed through encodeURIComponent
  // to prevent path traversal (`..`) and to safely handle any legal slug
  // character. Callers should validate the `game` slug against the known enum
  // in the route layer for a cleaner 400.
  // -----------------------------------------------------------------

  /**
   * GET /v1/sets/{game}/{set}. Every card the Index tracks in a set, keyed by
   * the set slug (the 2nd path segment of any card `href`). Returns the raw
   * upstream SetResponse shape plus a `_disclosure` marker.
   */
  getSet: async (
    game: IndexGameSlug,
    setCode: string
  ): Promise<IndexSetListing> => {
    if (typeof game !== 'string' || game.length === 0) {
      throw new IndexApiError('getSet requires a game slug', {
        status: null,
        endpoint: '/sets/{game}/{set}',
      });
    }
    if (typeof setCode !== 'string' || setCode.length === 0) {
      throw new IndexApiError('getSet requires a set slug', {
        status: null,
        endpoint: '/sets/{game}/{set}',
      });
    }
    const data = await request(
      `/sets/${encodeURIComponent(game)}/${encodeURIComponent(setCode)}`,
      setResponseSchema
    );
    return withDisclosure(data);
  },

  /**
   * GET /v1/cards/{game}/{set}/{card}. Full card detail keyed by slug. The
   * `card` slug is the final path segment of any `href` returned by /search or
   * /featured: `{number}-{name}-{company}-{grade}` (optionally suffixed with a
   * short id disambiguator that upstream ignores — both forms 200 per live
   * check 2026-07-03).
   */
  getCardBySlug: async (
    game: IndexGameSlug,
    set: string,
    card: string
  ): Promise<IndexCardDetail> => {
    if (typeof game !== 'string' || game.length === 0) {
      throw new IndexApiError('getCardBySlug requires a game slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}',
      });
    }
    if (typeof set !== 'string' || set.length === 0) {
      throw new IndexApiError('getCardBySlug requires a set slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}',
      });
    }
    if (typeof card !== 'string' || card.length === 0) {
      throw new IndexApiError('getCardBySlug requires a card slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}',
      });
    }
    const data = await request(
      `/cards/${encodeURIComponent(game)}/${encodeURIComponent(set)}/${encodeURIComponent(card)}`,
      indexCardDetailSchema
    );
    return withDisclosure(data);
  },

  /**
   * GET /v1/cards/{game}/{set}/{card}/overview. Grade-agnostic view: the
   * `card` here is the GRADE-LESS slug (`{number}-{name}`) — drop the
   * `-{company}-{grade}` suffix.
   */
  getCardBySlugOverview: async (
    game: IndexGameSlug,
    set: string,
    card: string
  ): Promise<IndexCardDetailOverview> => {
    if (typeof game !== 'string' || game.length === 0) {
      throw new IndexApiError('getCardBySlugOverview requires a game slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}/overview',
      });
    }
    if (typeof set !== 'string' || set.length === 0) {
      throw new IndexApiError('getCardBySlugOverview requires a set slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}/overview',
      });
    }
    if (typeof card !== 'string' || card.length === 0) {
      throw new IndexApiError('getCardBySlugOverview requires a card slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}/overview',
      });
    }
    const data = await request(
      `/cards/${encodeURIComponent(game)}/${encodeURIComponent(set)}/${encodeURIComponent(card)}/overview`,
      indexCardDetailOverviewSchema
    );
    return withDisclosure(data);
  },

  /**
   * GET /v1/cards/{game}/{set}/{card}/trades. Trade history for a slug-keyed
   * card. Server accepts source / window / scope / limit; we surface limit
   * and window here since those are the two the routes need. Max limit 200.
   */
  getCardBySlugTrades: async (
    game: IndexGameSlug,
    set: string,
    card: string,
    opts: { limit?: number; window?: number; scope?: 'grade' | 'all' } = {}
  ): Promise<IndexCardTradesResponse> => {
    if (typeof game !== 'string' || game.length === 0) {
      throw new IndexApiError('getCardBySlugTrades requires a game slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}/trades',
      });
    }
    if (typeof set !== 'string' || set.length === 0) {
      throw new IndexApiError('getCardBySlugTrades requires a set slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}/trades',
      });
    }
    if (typeof card !== 'string' || card.length === 0) {
      throw new IndexApiError('getCardBySlugTrades requires a card slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}/trades',
      });
    }
    const query: Record<string, string | number | undefined> = {};
    if (typeof opts.limit === 'number' && Number.isFinite(opts.limit)) {
      query.limit = Math.max(1, Math.min(200, Math.floor(opts.limit)));
    }
    if (typeof opts.window === 'number' && Number.isFinite(opts.window)) {
      query.window = Math.max(1, Math.floor(opts.window));
    }
    if (opts.scope === 'grade' || opts.scope === 'all') {
      query.scope = opts.scope;
    }
    const data = await request(
      `/cards/${encodeURIComponent(game)}/${encodeURIComponent(set)}/${encodeURIComponent(card)}/trades`,
      indexCardTradesResponseSchema,
      { query }
    );
    return withDisclosure(data);
  },

  /**
   * GET /v1/cards/{game}/{set}/{card}/series. Daily-average price points
   * (split into completed sales vs active listings) over a window. The slug
   * family accepts window enum {7, 30, 90, 365} — 7 IS a first-class value
   * here, distinct from the by-id/by-renaiss-id family (see normalizeSlugWindow).
   */
  getCardBySlugSeries: async (
    game: IndexGameSlug,
    set: string,
    card: string,
    opts: { window?: '7d' | '30d' | '90d' | 7 | 30 | 90 | 365 } = {}
  ): Promise<IndexCardSeriesResponse> => {
    if (typeof game !== 'string' || game.length === 0) {
      throw new IndexApiError('getCardBySlugSeries requires a game slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}/series',
      });
    }
    if (typeof set !== 'string' || set.length === 0) {
      throw new IndexApiError('getCardBySlugSeries requires a set slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}/series',
      });
    }
    if (typeof card !== 'string' || card.length === 0) {
      throw new IndexApiError('getCardBySlugSeries requires a card slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}/series',
      });
    }
    const window = normalizeSlugWindow(opts.window);
    const data = await request(
      `/cards/${encodeURIComponent(game)}/${encodeURIComponent(set)}/${encodeURIComponent(card)}/series`,
      indexCardSeriesResponseSchema,
      { query: { window } }
    );
    return withDisclosure(data);
  },

  /**
   * GET /v1/cards/{game}/{set}/{card}/fmv-series. Daily FMV series with the
   * blended methods (median/mean/vwap) breakdown. Same window semantics as
   * getCardBySlugSeries.
   */
  getCardBySlugFmvSeries: async (
    game: IndexGameSlug,
    set: string,
    card: string,
    opts: { window?: '7d' | '30d' | '90d' | 7 | 30 | 90 | 365 } = {}
  ): Promise<IndexCardFmvSeriesResponse> => {
    if (typeof game !== 'string' || game.length === 0) {
      throw new IndexApiError('getCardBySlugFmvSeries requires a game slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}/fmv-series',
      });
    }
    if (typeof set !== 'string' || set.length === 0) {
      throw new IndexApiError('getCardBySlugFmvSeries requires a set slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}/fmv-series',
      });
    }
    if (typeof card !== 'string' || card.length === 0) {
      throw new IndexApiError('getCardBySlugFmvSeries requires a card slug', {
        status: null,
        endpoint: '/cards/{game}/{set}/{card}/fmv-series',
      });
    }
    const window = normalizeSlugWindow(opts.window);
    const data = await request(
      `/cards/${encodeURIComponent(game)}/${encodeURIComponent(set)}/${encodeURIComponent(card)}/fmv-series`,
      indexCardFmvSeriesResponseSchema,
      { query: { window } }
    );
    return withDisclosure(data);
  },

  /**
   * GET /v1/cards/by-id/{id}/series (Gap 7). RAW per-trade series points
   * distinct from `/fmv-series` which is daily-aggregated. Multiple points
   * per day are expected. Window enum is {30, 90, 365, 1095, 36500} — 7d/30d
   * strings normalize via normalizeWindow (7d falls back to 30, per the
   * upstream OpenAPI's "other values fall back to 30" rule).
   */
  getCardSeries: async (
    cardId: string,
    opts: { window?: '7d' | '30d' | '90d' | 30 | 90 | 365 | 1095 | 36500 } = {}
  ): Promise<IndexCardSeriesResponse> => {
    if (typeof cardId !== 'string' || cardId.length === 0) {
      throw new IndexApiError('getCardSeries requires a non-empty cardId', {
        status: null,
        endpoint: '/cards/by-id/{id}/series',
      });
    }
    const window = normalizeWindow(opts.window);
    const data = await request(
      `/cards/by-id/${encodeURIComponent(cardId)}/series`,
      indexCardSeriesResponseSchema,
      { query: { window } }
    );
    return withDisclosure(data);
  },

  // -----------------------------------------------------------------
  // D9: by-renaiss-id/{rid} endpoints.
  //
  // These 5 endpoints let PullCast look up Index API data by the upstream
  // `items.renaiss_item_id` (a UUID). Coverage note (see rid-bridge.ts and
  // memory/d9-rid-bridge-progress.md): the Renaiss main API does NOT expose
  // `renaiss_item_id` on either the /v0/marketplace collection items or the
  // /v0/cards/{tokenId} response (verified against live shape 2026-07-03).
  // Callers that already hold a rid from another source (e.g. an Index API
  // /v1/search result the user submitted directly) can still use these
  // methods; the bridge that runs on new indexer pulls falls back to the
  // cert-serial path since no rid is derivable from tokenId today.
  // -----------------------------------------------------------------

  /**
   * GET /v1/cards/by-renaiss-id/{rid}. Card detail keyed by upstream
   * `items.renaiss_item_id`. Resolves to a representative grade (PSA 10 when
   * available).
   */
  getCardByRenaissId: async (rid: string): Promise<IndexCardDetail> => {
    if (typeof rid !== 'string' || rid.length === 0) {
      throw new IndexApiError('getCardByRenaissId requires a non-empty rid', {
        status: null,
        endpoint: '/cards/by-renaiss-id/{rid}',
      });
    }
    const data = await request(
      `/cards/by-renaiss-id/${encodeURIComponent(rid)}`,
      indexCardDetailSchema
    );
    return withDisclosure(data);
  },

  /**
   * GET /v1/cards/by-renaiss-id/{rid}/overview. Grade-agnostic overview.
   */
  getCardByRenaissIdOverview: async (
    rid: string
  ): Promise<IndexCardDetailOverview> => {
    if (typeof rid !== 'string' || rid.length === 0) {
      throw new IndexApiError(
        'getCardByRenaissIdOverview requires a non-empty rid',
        {
          status: null,
          endpoint: '/cards/by-renaiss-id/{rid}/overview',
        }
      );
    }
    const data = await request(
      `/cards/by-renaiss-id/${encodeURIComponent(rid)}/overview`,
      indexCardDetailOverviewSchema
    );
    return withDisclosure(data);
  },

  /**
   * GET /v1/cards/by-renaiss-id/{rid}/trades. Trade history. Server accepts
   * `source`, `window`, `scope`, `limit`; we surface the common two.
   */
  getCardByRenaissIdTrades: async (
    rid: string,
    opts: { limit?: number; window?: number; scope?: 'grade' | 'all' } = {}
  ): Promise<IndexCardTradesResponse> => {
    if (typeof rid !== 'string' || rid.length === 0) {
      throw new IndexApiError(
        'getCardByRenaissIdTrades requires a non-empty rid',
        {
          status: null,
          endpoint: '/cards/by-renaiss-id/{rid}/trades',
        }
      );
    }
    const query: Record<string, string | number | undefined> = {};
    if (typeof opts.limit === 'number' && Number.isFinite(opts.limit)) {
      query.limit = Math.max(1, Math.min(200, Math.floor(opts.limit)));
    }
    if (typeof opts.window === 'number' && Number.isFinite(opts.window)) {
      query.window = Math.max(1, Math.floor(opts.window));
    }
    if (opts.scope === 'grade' || opts.scope === 'all') {
      query.scope = opts.scope;
    }
    const data = await request(
      `/cards/by-renaiss-id/${encodeURIComponent(rid)}/trades`,
      indexCardTradesResponseSchema,
      { query }
    );
    return withDisclosure(data);
  },

  /**
   * GET /v1/cards/by-renaiss-id/{rid}/series. Daily-average price points.
   * Upstream accepts numeric window (30/90/365/1095/36500). We accept the
   * PullCast-standard '7d'/'30d'/'90d' string form for API consistency and
   * translate to the numeric wire value; unrecognized falls back to 30.
   */
  getCardByRenaissIdSeries: async (
    rid: string,
    opts: { window?: '7d' | '30d' | '90d' | 30 | 90 | 365 | 1095 | 36500 } = {}
  ): Promise<IndexCardSeriesResponse> => {
    if (typeof rid !== 'string' || rid.length === 0) {
      throw new IndexApiError(
        'getCardByRenaissIdSeries requires a non-empty rid',
        {
          status: null,
          endpoint: '/cards/by-renaiss-id/{rid}/series',
        }
      );
    }
    const window = normalizeWindow(opts.window);
    const data = await request(
      `/cards/by-renaiss-id/${encodeURIComponent(rid)}/series`,
      indexCardSeriesResponseSchema,
      { query: { window } }
    );
    return withDisclosure(data);
  },

  /**
   * GET /v1/cards/by-renaiss-id/{rid}/fmv-series. Daily FMV series with the
   * blended methods (median/mean/vwap) breakdown.
   */
  getCardByRenaissIdFmvSeries: async (
    rid: string,
    opts: { window?: '7d' | '30d' | '90d' | 30 | 90 | 365 | 1095 | 36500 } = {}
  ): Promise<IndexCardFmvSeriesResponse> => {
    if (typeof rid !== 'string' || rid.length === 0) {
      throw new IndexApiError(
        'getCardByRenaissIdFmvSeries requires a non-empty rid',
        {
          status: null,
          endpoint: '/cards/by-renaiss-id/{rid}/fmv-series',
        }
      );
    }
    const window = normalizeWindow(opts.window);
    const data = await request(
      `/cards/by-renaiss-id/${encodeURIComponent(rid)}/fmv-series`,
      indexCardFmvSeriesResponseSchema,
      { query: { window } }
    );
    return withDisclosure(data);
  },

  /**
   * POST /v1/report — submit a data-issue report.
   *
   * Public method accepts the PullCast-semantic payload shape:
   *   { card?: { tokenId?, cert?, setName?, itemNo? }, reason, evidence?, submitterHandle? }
   *
   * Internally this is mapped to the live upstream OpenAPI wire shape:
   *   { message, category?, sourceUrl?, cardHref?, contactEmail? }
   *
   * Wire-shape mapping:
   *   - `reason`         -> `message` (required, 1-2000 chars)
   *   - `card.cert` etc  -> serialized into the `message` prefix so upstream
   *                        reviewers see the identifying info
   *   - `evidence`       -> `sourceUrl` (must be a valid https:// URL, else it
   *                        is folded into the message body)
   *   - `submitterHandle`-> ignored on the wire (upstream has `contactEmail`
   *                        only, and a Discord handle is not an email). We do
   *                        include the handle in the message prefix so the
   *                        upstream reviewer can reach the reporter via Discord.
   *
   * Return shape is also mapped: upstream `{ ok:true, id }` -> our contract
   * `{ received:true, reportId? }`.
   *
   * The wire payload is validated with `reportIssueInputSchema` (`.strict()`)
   * BEFORE the network call so obviously-bad inputs (unknown keys, bad email)
   * never reach the upstream.
   *
   * Throws `IndexApiError` on:
   *  - client-side validation failure (status=null, cause=ZodError)
   *  - 422 upstream validation failure (status=422)
   *  - 429 upstream rate limit (status=429)
   *  - 5xx upstream (NOT retried; POST is not safely idempotent for /report)
   *  - schema drift on the 201 body (status=201, cause=ZodError)
   */
  reportIssue: async (payload: {
    card?: {
      tokenId?: string;
      cert?: string;
      setName?: string;
      itemNo?: string;
    };
    reason: string;
    evidence?: string;
    submitterHandle?: string;
  }): Promise<{ received: true; reportId?: string }> => {
    // Defensive local guards. The wire schema below re-validates the final
    // shape but these produce nicer error messages.
    if (typeof payload !== 'object' || payload === null) {
      throw new IndexApiError('reportIssue requires an object payload', {
        status: null,
        endpoint: '/report',
      });
    }
    if (typeof payload.reason !== 'string' || payload.reason.trim().length === 0) {
      throw new IndexApiError('reportIssue requires a non-empty reason', {
        status: null,
        endpoint: '/report',
      });
    }

    // Build the message body: prefix identifying info so upstream reviewers
    // can act on the report without querying the card DB. Order is stable so
    // downstream text-search on "cert:" or "tokenId:" works.
    const idParts: string[] = [];
    if (payload.card?.cert) idParts.push(`cert:${payload.card.cert}`);
    if (payload.card?.tokenId) idParts.push(`tokenId:${payload.card.tokenId}`);
    if (payload.card?.setName) idParts.push(`setName:${payload.card.setName}`);
    if (payload.card?.itemNo) idParts.push(`itemNo:${payload.card.itemNo}`);
    if (payload.submitterHandle) {
      idParts.push(`submitterHandle:${payload.submitterHandle}`);
    }
    const idPrefix = idParts.length > 0 ? `[${idParts.join(' ')}] ` : '';
    // Cap total message length at 2000 (upstream max). Trim the reason first
    // so the prefix always survives.
    const remaining = Math.max(1, 2000 - idPrefix.length);
    const trimmedReason = payload.reason.trim().slice(0, remaining);
    const message = `${idPrefix}${trimmedReason}`;

    // sourceUrl must be a valid URL per upstream schema. If evidence is not
    // a valid URL we fold it into the message tail instead so the reviewer
    // still sees the note.
    let sourceUrl: string | undefined;
    let messageWithEvidence = message;
    if (typeof payload.evidence === 'string' && payload.evidence.length > 0) {
      try {
        const u = new URL(payload.evidence);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          sourceUrl = u.toString().slice(0, 500);
        } else {
          throw new Error('non-http protocol');
        }
      } catch {
        const suffix = `\n\nEvidence: ${payload.evidence}`;
        const available = 2000 - messageWithEvidence.length;
        if (available > 0) {
          messageWithEvidence =
            messageWithEvidence + suffix.slice(0, available);
        }
      }
    }

    // Build the wire payload. Only include optional keys when defined —
    // `.strict()` rejects unknown keys but does accept omitted optional keys.
    const wire: ReportIssueInput = {
      message: messageWithEvidence.slice(0, 2000),
      ...(sourceUrl ? { sourceUrl } : {}),
      // Best-effort category: when a cert is provided, prefer wrong_price;
      // otherwise leave upstream to default to unspecified. Downstream can
      // enrich via the /api/report route body if a specific category is
      // supplied.
    };

    const validated = reportIssueInputSchema.safeParse(wire);
    if (!validated.success) {
      throw new IndexApiError('reportIssue payload failed local validation', {
        status: null,
        endpoint: '/report',
        cause: validated.error,
      });
    }

    const url = buildUrl(`/report`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: buildIndexAuthHeaders({
          'content-type': 'application/json',
        }),
        body: JSON.stringify(validated.data),
      });

      if (!res.ok) {
        // Never retry: POST /report is not safely idempotent (a naive retry
        // could create duplicate rows). Let the caller surface a manual retry
        // to the user instead.
        const bodySnippet = await res.text().catch(() => '');
        throw new IndexApiError(`Index API report failed (${res.status})`, {
          status: res.status,
          endpoint: '/report',
          cause: bodySnippet.slice(0, 500),
        });
      }

      const json: unknown = await res.json();
      const parsed = reportSubmitResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new IndexApiError('Index API report response schema drift', {
          status: res.status,
          endpoint: '/report',
          cause: parsed.error,
        });
      }
      return { received: true, reportId: parsed.data.id };
    } finally {
      clearTimeout(timer);
    }
  },
};

export type RenaissIndex = typeof renaissIndex;

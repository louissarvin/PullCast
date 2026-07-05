/**
 * GET /api/marketplace - filtered marketplace search proxy.
 *
 * Thin wrapper around `renaissApi.searchMarketplace` that fronts the live
 * Renaiss `/v0/marketplace` endpoint with:
 *   - Boundary input validation (bounded strings, enum whitelisting, int bounds).
 *   - In-process 60s cache keyed by canonical filter tuple to reduce upstream
 *     fan-out. Cache is process-local; we do NOT persist to Redis in Bronze.
 *   - Per-IP rate limit (30/min) via the shared token-bucket in
 *     `src/lib/rate-limit.ts` (Postgres-backed, atomic).
 *   - Standard D8 envelope `{ data, sources, warnings, generated_at }`.
 *   - Graceful 404 / timeout handling: upstream failures surface as 502 with a
 *     generic message; stack traces never leave the server.
 *
 * OWASP references applied:
 *   - REST Cheat Sheet: input validation, generic client errors, structured
 *     server logs, rate-limiting per IP.
 *   - API Security Top 10 API4 (unrestricted resource consumption): the `limit`
 *     query param is hard-capped at 100 (matches upstream contract) and the
 *     upstream `getMarketplaceListings`-style client-side hydration is bounded
 *     by 60s cache reuse.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { renaissApi, RenaissApiError } from '../lib/renaiss/index.ts';
import type { RenaissMarketplaceSearchResponse } from '../lib/renaiss/index.ts';
import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import { buildEnvelope } from '../utils/envelope.ts';
import { handleError } from '../utils/errorHandler.ts';
import { isUrlLikeSearchValue } from '../utils/marketplaceSearchGuard.ts';

const LOG_PREFIX = '[marketplace]';

const MARKETPLACE_SOURCE = {
  label: 'Renaiss main API (beta)',
  url: 'https://api.renaiss.xyz/v0/marketplace',
} as const;

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

const CATEGORY_VALUES = new Set(['POKEMON', 'ONE_PIECE']);
const GRADING_COMPANY_VALUES = new Set(['PSA', 'BGS', 'CGC', 'SGC']);
const SORT_BY_VALUES = new Set([
  'fmvPriceInUsd',
  'priceRange',
  'year',
  'grade',
  'name',
  'listDate',
  'mintDate',
]);
const SORT_ORDER_VALUES = new Set(['asc', 'desc']);

const LANGUAGE_VALUES = new Set([
  '',
  'Chinese',
  'English',
  'Japanese',
  'Traditional Chinese',
  'Simplified Chinese',
  'Korean',
  'Indonesian',
  'Portuguese',
  'Italian',
  'German',
  'Polish',
  'French',
  'Spanish',
]);

// Free-text bounds. Upstream caps `search` at [3, 150]. `gradeFilter`,
// `yearRange`, `priceRangeFilter` are open strings; we cap them at 64 to
// prevent oversized query params. `yearRange` and `priceRangeFilter` are
// additionally shape-checked.
const SEARCH_MIN = 3;
const SEARCH_MAX = 150;
const FIELD_MAX = 64;

const YEAR_RANGE_RX = /^\d{4}(-\d{4})?$/;
const PRICE_RANGE_RX = /^\d+(-\d+)?$/;

/**
 * Filter tuple used for cache keying + upstream call. `undefined` means "not
 * filtered on this axis".
 */
interface MarketplaceFilters {
  search?: string;
  categoryFilter?: 'POKEMON' | 'ONE_PIECE';
  listedOnly?: boolean;
  languageFilter?: string;
  gradingCompanyFilter?: 'PSA' | 'BGS' | 'CGC' | 'SGC';
  gradeFilter?: string;
  yearRange?: string;
  priceRangeFilter?: string;
  sortBy?:
    | 'fmvPriceInUsd'
    | 'priceRange'
    | 'year'
    | 'grade'
    | 'name'
    | 'listDate'
    | 'mintDate';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

interface ParseResult {
  ok: true;
  filters: MarketplaceFilters;
}

interface ParseError {
  ok: false;
  message: string;
}

const clientIp = (request: FastifyRequest): string => {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  return 'unknown';
};

const consumeIpToken = async (request: FastifyRequest): Promise<boolean> => {
  return consumeRateLimitToken(`http:ip:${clientIp(request)}:marketplace`, 30, 30);
};

/**
 * Coerce a query value to a trimmed non-empty string, or `undefined`. Arrays
 * (a client passing `?foo=a&foo=b`) collapse to the first entry - Fastify
 * gives us `string | string[]` for repeat keys and we do not support fan-out.
 */
const coerceString = (raw: unknown): string | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

const coerceBool = (raw: unknown): { ok: true; value?: boolean } | { ok: false } => {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string') return { ok: false };
  const s = v.trim().toLowerCase();
  if (s === '' ) return { ok: true, value: undefined };
  if (s === 'true' || s === '1') return { ok: true, value: true };
  if (s === 'false' || s === '0') return { ok: true, value: false };
  return { ok: false };
};

const coerceInt = (raw: unknown): { ok: true; value?: number } | { ok: false } => {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string' || v.trim().length === 0) return { ok: true, value: undefined };
  if (!/^-?\d+$/.test(v.trim())) return { ok: false };
  const n = parseInt(v.trim(), 10);
  if (!Number.isFinite(n)) return { ok: false };
  return { ok: true, value: n };
};

const parseFilters = (query: Record<string, unknown>): ParseResult | ParseError => {
  const filters: MarketplaceFilters = {};

  const search = coerceString(query.search);
  if (search !== undefined) {
    if (search.length < SEARCH_MIN || search.length > SEARCH_MAX) {
      return {
        ok: false,
        message: `search must be ${SEARCH_MIN}..${SEARCH_MAX} characters`,
      };
    }
    // D8-M-3 (security): reject URL-like values BEFORE they flow to the
    // upstream proxy. See `isUrlLikeSearchValue` above for the rationale.
    if (isUrlLikeSearchValue(search)) {
      return {
        ok: false,
        message:
          'search must not look like a URL or contain control characters',
      };
    }
    filters.search = search;
  }

  const category = coerceString(query.categoryFilter);
  if (category !== undefined) {
    if (!CATEGORY_VALUES.has(category)) {
      return {
        ok: false,
        message: `categoryFilter must be one of: ${Array.from(CATEGORY_VALUES).join(', ')}`,
      };
    }
    filters.categoryFilter = category as MarketplaceFilters['categoryFilter'];
  }

  const listed = coerceBool(query.listedOnly);
  if (!listed.ok) {
    return { ok: false, message: 'listedOnly must be true or false' };
  }
  filters.listedOnly = listed.value;

  const language = coerceString(query.languageFilter);
  if (language !== undefined) {
    if (!LANGUAGE_VALUES.has(language)) {
      return {
        ok: false,
        message: 'languageFilter is not a supported language',
      };
    }
    filters.languageFilter = language;
  }

  const grading = coerceString(query.gradingCompanyFilter);
  if (grading !== undefined) {
    if (!GRADING_COMPANY_VALUES.has(grading)) {
      return {
        ok: false,
        message: `gradingCompanyFilter must be one of: ${Array.from(GRADING_COMPANY_VALUES).join(', ')}`,
      };
    }
    filters.gradingCompanyFilter = grading as MarketplaceFilters['gradingCompanyFilter'];
  }

  const grade = coerceString(query.gradeFilter);
  if (grade !== undefined) {
    if (grade.length > FIELD_MAX) {
      return { ok: false, message: `gradeFilter is too long (max ${FIELD_MAX})` };
    }
    filters.gradeFilter = grade;
  }

  const yearRange = coerceString(query.yearRange);
  if (yearRange !== undefined) {
    if (!YEAR_RANGE_RX.test(yearRange)) {
      return {
        ok: false,
        message: 'yearRange must look like "2023" or "2020-2025"',
      };
    }
    filters.yearRange = yearRange;
  }

  const priceRange = coerceString(query.priceRangeFilter);
  if (priceRange !== undefined) {
    if (!PRICE_RANGE_RX.test(priceRange)) {
      return {
        ok: false,
        message: 'priceRangeFilter must look like "1000" or "1000-50000"',
      };
    }
    filters.priceRangeFilter = priceRange;
  }

  const sortBy = coerceString(query.sortBy);
  if (sortBy !== undefined) {
    if (!SORT_BY_VALUES.has(sortBy)) {
      return {
        ok: false,
        message: `sortBy must be one of: ${Array.from(SORT_BY_VALUES).join(', ')}`,
      };
    }
    filters.sortBy = sortBy as MarketplaceFilters['sortBy'];
  }

  const sortOrder = coerceString(query.sortOrder);
  if (sortOrder !== undefined) {
    if (!SORT_ORDER_VALUES.has(sortOrder)) {
      return { ok: false, message: 'sortOrder must be asc or desc' };
    }
    filters.sortOrder = sortOrder as MarketplaceFilters['sortOrder'];
  }

  const limit = coerceInt(query.limit);
  if (!limit.ok) return { ok: false, message: 'limit must be an integer' };
  if (limit.value !== undefined) {
    if (limit.value < MIN_LIMIT || limit.value > MAX_LIMIT) {
      return {
        ok: false,
        message: `limit must be in [${MIN_LIMIT}, ${MAX_LIMIT}]`,
      };
    }
    filters.limit = limit.value;
  }

  const offset = coerceInt(query.offset);
  if (!offset.ok) return { ok: false, message: 'offset must be an integer' };
  if (offset.value !== undefined) {
    if (offset.value < 0) return { ok: false, message: 'offset must be >= 0' };
    filters.offset = offset.value;
  }

  return { ok: true, filters };
};

/**
 * Deterministic cache key. We include every filter axis (in a stable order)
 * so two structurally-equal queries hit the same cache entry regardless of
 * how the client ordered them.
 */
const cacheKey = (f: MarketplaceFilters): string => {
  const parts: string[] = [
    `s=${f.search ?? ''}`,
    `cat=${f.categoryFilter ?? ''}`,
    `listed=${f.listedOnly === undefined ? '' : String(f.listedOnly)}`,
    `lang=${f.languageFilter ?? ''}`,
    `grader=${f.gradingCompanyFilter ?? ''}`,
    `grade=${f.gradeFilter ?? ''}`,
    `yr=${f.yearRange ?? ''}`,
    `pr=${f.priceRangeFilter ?? ''}`,
    `sortBy=${f.sortBy ?? ''}`,
    `sortOrder=${f.sortOrder ?? ''}`,
    `limit=${f.limit ?? DEFAULT_LIMIT}`,
    `offset=${f.offset ?? 0}`,
  ];
  return parts.join('|');
};

interface CacheEntry {
  expiresAt: number;
  data: RenaissMarketplaceSearchResponse;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 256; // bounded to prevent unbounded memory growth
const cache = new Map<string, CacheEntry>();

/**
 * Best-effort LRU eviction. We do NOT need strict LRU here - a Map preserves
 * insertion order, and when we hit the ceiling we drop the oldest entry.
 * Under normal load the 60s TTL keeps the working set well below the cap.
 */
const cacheSet = (key: string, data: RenaissMarketplaceSearchResponse): void => {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, data });
};

const cacheGet = (key: string): RenaissMarketplaceSearchResponse | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.data;
};

const envelope = (data: RenaissMarketplaceSearchResponse) =>
  buildEnvelope(data, { sources: [MARKETPLACE_SOURCE] });

/**
 * Test-only helper. Never called at runtime. Exported so the test file can
 * reset the cache between assertions.
 */
export const __resetMarketplaceCache = (): void => {
  cache.clear();
};

export const marketplaceRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/marketplace',
    async (
      request: FastifyRequest<{ Querystring: Record<string, unknown> }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeIpToken(request))) {
        return handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');
      }

      const parsed = parseFilters(request.query ?? {});
      if (!parsed.ok) {
        return handleError(reply, 400, parsed.message, 'INVALID_PARAM');
      }

      const key = cacheKey(parsed.filters);
      const cached = cacheGet(key);
      if (cached !== null) {
        return reply.code(200).send(envelope(cached));
      }

      try {
        const data = await renaissApi.searchMarketplace(parsed.filters);
        cacheSet(key, data);
        return reply.code(200).send(envelope(data));
      } catch (err) {
        if (err instanceof RenaissApiError) {
          // 404 from upstream: return a clean empty result rather than a hard
          // fail so the client can render "no results" without extra branches.
          if (err.status === 404) {
            const empty: RenaissMarketplaceSearchResponse = {
              collection: [],
              pagination: {
                total: 0,
                limit: parsed.filters.limit ?? DEFAULT_LIMIT,
                offset: parsed.filters.offset ?? 0,
                hasMore: false,
              },
            };
            return reply.code(200).send(envelope(empty));
          }
          console.warn(
            `${LOG_PREFIX} upstream failed status=${err.status} endpoint=${err.endpoint}`
          );
          if (err.status !== null && err.status >= 400 && err.status < 500) {
            return handleError(
              reply,
              400,
              'Renaiss marketplace rejected the request. Check your filters.',
              'UPSTREAM_BAD_REQUEST'
            );
          }
          return handleError(
            reply,
            502,
            'Renaiss marketplace API unavailable. Please try again shortly.',
            'UPSTREAM_UNAVAILABLE'
          );
        }
        console.error(`${LOG_PREFIX} unexpected error:`, err);
        return handleError(
          reply,
          500,
          'Failed to load marketplace results',
          'MARKETPLACE_FAILED',
          err instanceof Error ? err : null
        );
      }
    }
  );

  done();
};

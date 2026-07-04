import { z } from 'zod';
import { RENAISS_API_BASE } from '../../config/main-config.ts';
import { RenaissApiError } from './errors.ts';
import {
  renaissPackSchema,
  renaissPacksListResponseSchema,
  renaissCardSchema,
  renaissListingsResponseSchema,
  renaissUserSchema,
  renaissMarketplaceSearchResponseSchema,
} from './schemas.ts';
import type {
  RenaissPack,
  RenaissPull,
  RenaissCard,
  RenaissListing,
  RenaissUser,
} from './types.ts';
import type {
  RenaissMarketplaceSearchResponse,
  RenaissPackListItem,
} from './schemas.ts';

/**
 * RFC 4122 UUID (any version). We accept any version because the openapi
 * contract says `format: uuid` without pinning v4; upstream also validates so
 * a bad UUID would fall through to a 400 anyway. We validate client-side to
 * (a) return a friendly error before consuming a network round trip, and
 * (b) block obviously-attacker input (SQL-ish, path traversal) at the boundary.
 */
const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REQUEST_TIMEOUT_MS = 8000;
const RETRY_BACKOFFS_MS = [250, 500, 1000];
const LOG_PREFIX = '[renaiss-api]';

/**
 * IMPORTANT: `RENAISS_API_BASE` already ends in `/v0`
 * (see `src/config/main-config.ts` -> default `https://api.renaiss.xyz/v0`).
 *
 * Every request path in this file MUST be relative to that base and MUST NOT
 * begin with `/v0/`. If you prefix a path with `/v0/`, the assembled URL will
 * be `https://api.renaiss.xyz/v0/v0/...` and every request will 404.
 *
 * This constant is intentionally empty; it exists so a grep for `V0_PREFIX`
 * finds this comment. If a future maintainer wants to add "/v0/" back for some
 * reason, they must change RENAISS_API_BASE too.
 */
const V0_PREFIX = '' as const;
// Reference the constant so lint does not remove it and future greps land here.
void V0_PREFIX;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns true when the error is retryable (5xx, network blip, AbortError).
 * 4xx responses are NEVER retried because they will keep returning the same.
 */
const isRetryableStatus = (status: number | null): boolean => {
  if (status === null) {
    return true; // network error
  }
  return status >= 500 && status < 600;
};

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
}

const buildUrl = (path: string, query?: RequestOptions['query']): string => {
  const base = RENAISS_API_BASE.replace(/\/+$/, '');
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
  const url = buildUrl(path, options.query);
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'pullcast-backend/0.1 (+https://github.com/pullcast)',
        },
      });

      if (!res.ok) {
        const status = res.status;
        // Only retry on 5xx; bail immediately on 4xx.
        if (!isRetryableStatus(status) || attempt === RETRY_BACKOFFS_MS.length) {
          const bodySnippet = await res.text().catch(() => '');
          throw new RenaissApiError(`Renaiss API request failed (${status})`, {
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
        throw new RenaissApiError('Renaiss API response failed schema validation', {
          status: res.status,
          endpoint: path,
          cause: parsed.error,
        });
      }
      return parsed.data;
    } catch (err) {
      lastError = err;
      // If it is already a non-retryable RenaissApiError, rethrow now.
      if (err instanceof RenaissApiError && !isRetryableStatus(err.status)) {
        throw err;
      }
      // Out of retries?
      if (attempt === RETRY_BACKOFFS_MS.length) {
        break;
      }
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG_PREFIX} retry path=${path} reason="${reason}" attempt=${attempt + 1}`);
      await sleep(RETRY_BACKOFFS_MS[attempt]);
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof RenaissApiError) {
    throw lastError;
  }
  throw new RenaissApiError('Renaiss API request failed after retries', {
    status: null,
    endpoint: path,
    cause: lastError,
  });
};

/**
 * Renaiss main API client. Read-only; no auth in Bronze.
 *
 * Endpoints used here are best-effort sketches derived from the research file
 * at /memory or /15_renaiss_api_cli_research.md. They may need small path
 * tweaks in D2 once the indexer hits them for real, but the shape, retry
 * policy, and timeout are stable.
 */
export const renaissApi = {
  /**
   * GET /packs/{slug}
   * Returns pack metadata. The `recentOpenedPacks` field carries the rolling
   * window of recent pulls and is what the indexer diffs against `Cursor`.
   */
  getPack: async (slug: string): Promise<RenaissPack> => {
    if (!slug || typeof slug !== 'string') {
      throw new RenaissApiError('getPack requires a non-empty slug', {
        status: null,
        endpoint: '/packs/{slug}',
      });
    }
    return request(`/packs/${encodeURIComponent(slug)}`, renaissPackSchema);
  },

  /**
   * GET /packs (base already includes /v0 -> assembled: /v0/packs)
   *
   * Returns the public list of card packs. Query param `includeInactive=true`
   * surfaces archived / soldout-or-restocking packs alongside the active ones;
   * the default behavior of the live upstream is to filter to active-ish only
   * (verified 2026-07-03: 4 packs default, 15 packs with includeInactive).
   *
   * The list surface has NO `recentOpenedPacks` window; consumers that need
   * pulls must fall back to `getPack(slug)`. Image URLs are also not surfaced
   * on the list surface; Discord embeds render text-only.
   */
  getPacks: async (
    opts: { includeInactive?: boolean } = {}
  ): Promise<RenaissPackListItem[]> => {
    const data = await request(`/packs`, renaissPacksListResponseSchema, {
      query: {
        // Only send the param when the caller opted in. Sending
        // `includeInactive=false` explicitly should be a no-op vs. omitting it,
        // but keeping the query string minimal avoids surprising upstream
        // logs.
        includeInactive: opts.includeInactive === true ? true : undefined,
      },
    });
    return Array.isArray(data.cardPacks) ? data.cardPacks : [];
  },

  /**
   * Returns the recent pulls for a pack. Convenience wrapper around getPack +
   * an optional time filter applied client-side.
   *
   * `since` is a unix timestamp in milliseconds. If provided, pulls with a
   * `pulledAtTimestamp` older than `since` are dropped.
   */
  getPackPulls: async (
    slug: string,
    opts: { since?: number; limit?: number } = {}
  ): Promise<RenaissPull[]> => {
    const pack = await renaissApi.getPack(slug);
    const all = Array.isArray(pack.recentOpenedPacks) ? pack.recentOpenedPacks : [];

    let filtered = all;
    if (opts.since !== undefined) {
      const cutoff = opts.since;
      filtered = filtered.filter((p) => {
        const ts = Date.parse(p.pulledAtTimestamp);
        return Number.isFinite(ts) && ts > cutoff;
      });
    }
    if (opts.limit !== undefined && opts.limit > 0) {
      filtered = filtered.slice(0, opts.limit);
    }
    return filtered;
  },

  /**
   * GET /cards/{tokenId}
   * Returns card metadata for a single Renaiss collectible.
   * Per 15_renaiss_api_cli_research.md Section 4.1 the verified live endpoint
   * is /v0/cards/{tokenId}. verbosePrice=true is required to surface
   * fmvPriceInUSD and askPriceInUSDT used by /price token.
   */
  getCard: async (
    tokenId: string,
    opts: { verbosePrice?: boolean; includeActivities?: boolean; activitiesLimit?: number } = {}
  ): Promise<RenaissCard> => {
    if (!tokenId || typeof tokenId !== 'string') {
      throw new RenaissApiError('getCard requires a non-empty tokenId', {
        status: null,
        endpoint: '/cards/{tokenId}',
      });
    }
    const parsed = await request(`/cards/${encodeURIComponent(tokenId)}`, renaissCardSchema, {
      query: {
        verbosePrice: opts.verbosePrice ?? true,
        includeActivities: opts.includeActivities,
        activitiesLimit: opts.activitiesLimit,
      },
    });
    // Emit the observed shape variant so drift can be spotted in the logs.
    // Mirrors `[Indexer] parsed pack shape=...` convention used by the pack
    // worker. Non-blocking; a missing `_shapeVariant` would only occur on a
    // typed-schema mistake and still would not fail the request.
    const variant = (parsed as { _shapeVariant?: string })._shapeVariant ?? 'unknown';
    console.log(`[Renaiss] parsed card shape=${variant} tokenId=${tokenId}`);
    return parsed;
  },

  /**
   * GET /marketplace/listings
   * Paginated listings feed used by /api/price/token/:tokenId for comp data.
   */
  getMarketplaceListings: async (opts: { limit?: number } = {}): Promise<RenaissListing[]> => {
    const data = await request(`/marketplace/listings`, renaissListingsResponseSchema, {
      query: { limit: opts.limit },
    });
    if (Array.isArray(data)) {
      return data;
    }
    if (data && Array.isArray(data.items)) {
      return data.items;
    }
    return [];
  },

  /**
   * GET /v0/marketplace
   *
   * Live-verified filter surface for the Renaiss marketplace. Param names taken
   * from `https://api.renaiss.xyz/openapi.json` (verified 2026-07-02):
   *   - search              string (3..150)
   *   - categoryFilter      "POKEMON" | "ONE_PIECE"
   *   - listedOnly          boolean
   *   - languageFilter      string (English, Japanese, ...)
   *   - gradingCompanyFilter "PSA" | "BGS" | "CGC" | "SGC"
   *   - gradeFilter         string (e.g. "10 Gem Mint")
   *   - yearRange           string (e.g. "2020-2025")
   *   - priceRangeFilter    string
   *   - sortBy              "fmvPriceInUsd" | "priceRange" | "year" | "grade" |
   *                         "name" | "listDate" | "mintDate"
   *   - sortOrder           "asc" | "desc"
   *   - limit               1..100 (default 10)
   *   - offset              >= 0
   *
   * Filters are OMITTED (not sent) when undefined so the upstream default
   * behavior is preserved. Booleans stringify to "true" / "false".
   *
   * No client-side validation of enum values here on purpose: the upstream
   * returns a clean 400 with a code, and the /browse Discord command already
   * pins the choices via SlashCommandBuilder. REST callers get the 400 relayed
   * with a generic message.
   */
  searchMarketplace: async (filters: {
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
  } = {}): Promise<RenaissMarketplaceSearchResponse> => {
    // Serialize booleans to "true"/"false" strings (URLSearchParams would emit
    // them the same way but our `buildUrl` uses `String(...)` which turns
    // undefined into "undefined" if we do not skip explicitly - `buildUrl`
    // already filters undefined values, so we just pass them through).
    // `RENAISS_API_BASE` already ends in `/v0`, so every path in this file is
    // written without the `/v0/` prefix. Adding it produces `/v0/v0/...` 404s.
    return request(`/marketplace`, renaissMarketplaceSearchResponseSchema, {
      query: {
        search: filters.search,
        categoryFilter: filters.categoryFilter,
        listedOnly: filters.listedOnly,
        languageFilter: filters.languageFilter,
        gradingCompanyFilter: filters.gradingCompanyFilter,
        gradeFilter: filters.gradeFilter,
        yearRange: filters.yearRange,
        priceRangeFilter: filters.priceRangeFilter,
        sortBy: filters.sortBy,
        sortOrder: filters.sortOrder,
        limit: filters.limit,
        offset: filters.offset,
      },
    });
  },

  /**
   * GET /users/{id}
   *
   * (Base URL already ends in `/v0`, so the assembled path is `/v0/users/{id}`.)
   *
   * The upstream `id` param is a UUID. We validate the shape BEFORE the
   * network call so obviously-bad input (a Discord ID, a wallet address, a SQL
   * fragment) can never touch the upstream and cannot show up in upstream logs.
   *
   * Returns the parsed user profile. Throws `RenaissApiError` on:
   *  - invalid UUID (status=null, cause=input)
   *  - 4xx upstream (status=<code>, includes the upstream body snippet)
   *  - schema drift (status=200, cause=ZodError)
   */
  getUser: async (uuid: string): Promise<RenaissUser> => {
    if (typeof uuid !== 'string' || !UUID_RX.test(uuid.trim())) {
      throw new RenaissApiError('getUser requires a valid RFC 4122 UUID', {
        status: null,
        endpoint: '/users/{id}',
      });
    }
    const normalized = uuid.trim().toLowerCase();
    return request(`/users/${encodeURIComponent(normalized)}`, renaissUserSchema);
  },

  /**
   * GET /packs/{slug} - shape-tolerant recent-pulls extractor.
   * (Base URL already ends in `/v0`, so the assembled path is `/v0/packs/{slug}`.)
   *
   * The live openapi contract wraps pack data under a `cardPack` key and gives
   * `pulledAtTimestamp` as a NUMBER (unix seconds). The older `getPack` helper
   * above still assumes root-level fields + string timestamps, which is a
   * legacy path used by the indexer worker. Rather than touch the indexer's
   * hot path mid-flight, this helper returns a normalized recent-pulls array
   * accepting BOTH shapes.
   *
   * Normalization output shape:
   *   { collectibleTokenId: string, tier: string | null,
   *     fmvCents: number | null, pulledAtMs: number }
   *
   * Consumers here: `oddsRoutes.upstream_recent`.
   */
  getPackRecent: async (
    slug: string
  ): Promise<
    Array<{
      collectibleTokenId: string;
      tier: string | null;
      fmvCents: number | null;
      pulledAtMs: number;
    }>
  > => {
    if (!slug || typeof slug !== 'string') {
      throw new RenaissApiError('getPackRecent requires a non-empty slug', {
        status: null,
        endpoint: '/packs/{slug}',
      });
    }
    // Raw fetch (no zod parse) so we can shape-shift without breaking either
    // legacy or current callers. We still cap the response size implicitly via
    // the shared timeout + fetch defaults.
    const url = buildUrl(`/packs/${encodeURIComponent(slug)}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let raw: unknown;
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'pullcast-backend/0.1 (+https://github.com/pullcast)',
        },
      });
      if (!res.ok) {
        const bodySnippet = await res.text().catch(() => '');
        throw new RenaissApiError(`Renaiss packs request failed (${res.status})`, {
          status: res.status,
          endpoint: '/packs/{slug}',
          cause: bodySnippet.slice(0, 500),
        });
      }
      raw = await res.json();
    } finally {
      clearTimeout(timer);
    }

    // Accept both shapes: { cardPack: { recentOpenedPacks: [...] } } and the
    // older root-level { recentOpenedPacks: [...] }.
    const root = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
    const inner =
      root.cardPack && typeof root.cardPack === 'object'
        ? (root.cardPack as Record<string, unknown>)
        : root;
    const arr = inner.recentOpenedPacks;
    if (!Array.isArray(arr)) return [];

    const normalized: Array<{
      collectibleTokenId: string;
      tier: string | null;
      fmvCents: number | null;
      pulledAtMs: number;
    }> = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const tokenId = typeof e.collectibleTokenId === 'string' ? e.collectibleTokenId : null;
      if (tokenId === null) continue;
      // tier: string or null; anything else -> null
      const tier =
        typeof e.tier === 'string' && e.tier.length > 0 ? e.tier.toLowerCase() : null;
      // fmv: string cents (main API) or number cents (fallback)
      let fmvCents: number | null = null;
      if (typeof e.fmv === 'string' && /^\d+$/.test(e.fmv)) {
        fmvCents = Number(e.fmv);
        if (!Number.isFinite(fmvCents)) fmvCents = null;
      } else if (typeof e.fmv === 'number' && Number.isFinite(e.fmv)) {
        fmvCents = Math.trunc(e.fmv);
      }
      // pulledAtTimestamp: number (unix seconds) OR string ISO
      let pulledAtMs = 0;
      if (typeof e.pulledAtTimestamp === 'number' && Number.isFinite(e.pulledAtTimestamp)) {
        // Heuristic: if it looks like seconds (< 10^12), convert to ms.
        pulledAtMs =
          e.pulledAtTimestamp < 1e12 ? e.pulledAtTimestamp * 1000 : e.pulledAtTimestamp;
      } else if (typeof e.pulledAtTimestamp === 'string') {
        const parsed = Date.parse(e.pulledAtTimestamp);
        if (Number.isFinite(parsed)) pulledAtMs = parsed;
      }
      normalized.push({ collectibleTokenId: tokenId, tier, fmvCents, pulledAtMs });
    }
    return normalized;
  },

  /**
   * GET /cards/{tokenId} - shape-tolerant owner-address extractor.
   * (Base URL already ends in `/v0`, so assembled path is `/v0/cards/{tokenId}`.)
   *
   * The current live response wraps the collectible under a `collectible` key:
   *   { collectible: { ownerAddress: "0x...", ... }, pricing: {...}, activities: {...} }
   * The legacy sketch put `ownerAddress` at the root. This helper accepts both
   * and returns the normalized 0x-lowercased address, or `null` if the upstream
   * did not carry one (freshly-minted token not yet indexed, upstream error, or
   * a shape variant we do not recognize).
   *
   * Returns `null` on 404 so callers can retry / fall back without try/catch
   * plumbing. Throws `RenaissApiError` on non-404 upstream errors and network
   * failures so the indexer's cursor-failure path still trips.
   *
   * NOTE: this does NOT go through the zod-validated `getCard` above, which is
   * pinned to a different schema shape. Using a dedicated helper keeps the
   * indexer's buyer-resolution workaround isolated from schema drift on the
   * broader card object.
   */
  resolveCardOwner: async (tokenId: string): Promise<string | null> => {
    if (!tokenId || typeof tokenId !== 'string') {
      throw new RenaissApiError('resolveCardOwner requires a non-empty tokenId', {
        status: null,
        endpoint: '/cards/{tokenId}',
      });
    }
    // Reject non-decimal tokenIds early. Renaiss tokenIds are uint256 decimal
    // strings; anything else is either a bug in the caller or attacker input.
    if (!/^\d+$/.test(tokenId)) {
      throw new RenaissApiError('resolveCardOwner requires a decimal tokenId', {
        status: null,
        endpoint: '/cards/{tokenId}',
      });
    }

    const url = buildUrl(`/cards/${encodeURIComponent(tokenId)}`, {
      verbosePrice: false,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let raw: unknown;
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'pullcast-backend/0.1 (+https://github.com/pullcast)',
        },
      });
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        const bodySnippet = await res.text().catch(() => '');
        throw new RenaissApiError(`Renaiss cards request failed (${res.status})`, {
          status: res.status,
          endpoint: '/cards/{tokenId}',
          cause: bodySnippet.slice(0, 500),
        });
      }
      raw = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const root = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
    // Accept both shapes: { collectible: { ownerAddress } } (current live) and
    // { ownerAddress } (legacy root-level).
    const inner =
      root.collectible && typeof root.collectible === 'object'
        ? (root.collectible as Record<string, unknown>)
        : root;
    const owner = inner.ownerAddress;
    if (typeof owner !== 'string' || owner.length === 0) {
      return null;
    }
    // Enforce 0x-prefixed 40-hex-char EVM address; otherwise treat as absent
    // rather than persist a malformed value.
    const norm = owner.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(norm)) {
      return null;
    }
    return norm;
  },

  /**
   * GET /health (base already includes /v0 -> assembled: /v0/health)
   *
   * Cheap upstream liveness probe. 2s timeout, NO retry: health checks must
   * fail fast so `/health/upstream` on our side can render a per-source status
   * without hanging on a stuck peer. Never throws — returns a structured
   * result so callers can shove it into `Promise.allSettled`.
   *
   * Live shape (2026-07-03): `{ status: "ok", timestamp: "..." }`.
   */
  getHealth: async (): Promise<
    | { ok: true; status: string | null; timestamp: string | null; latencyMs: number }
    | { ok: false; error: string; latencyMs: number }
  > => {
    const url = buildUrl(`/health`);
    const controller = new AbortController();
    const HEALTH_TIMEOUT_MS = 2000;
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'pullcast-backend/0.1 (+https://github.com/pullcast)',
        },
      });
      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        return { ok: false, error: `upstream_${res.status}`, latencyMs };
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const root = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {});
      const status = typeof root.status === 'string' ? root.status : null;
      const timestamp = typeof root.timestamp === 'string' ? root.timestamp : null;
      return { ok: true, status, timestamp, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, error: reason.slice(0, 200), latencyMs };
    } finally {
      clearTimeout(timer);
    }
  },
};

export type RenaissApi = typeof renaissApi;

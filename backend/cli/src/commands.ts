/**
 * Command handlers for `pullcast`.
 *
 * Every handler is pure(-ish): it accepts a `context` bag (config + fetch impl)
 * so tests can inject a mock fetch and observe the exact URL constructed +
 * envelope emitted.
 *
 * Each handler returns an `Envelope<T>` when the command produced data. The
 * outer program layer (in `index.ts`) is responsible for printing JSON or the
 * pretty-formatted variant.
 */

import { loadConfig, type CliConfig } from './config.ts';
import { envelope, type Envelope, type EnvelopeSource } from './envelope.ts';
import { getJson, HttpError } from './http.ts';
import type {
  GradedLike,
  TileLike,
  FeaturedLike,
  PullLike,
  PriceLike,
  MarketplaceRowLike,
  MarketplacePaginationLike,
  CardBlendLike,
} from './format.ts';

export interface CommandContext {
  config: CliConfig;
  fetchImpl?: typeof fetch;
}

export function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    config: overrides.config ?? loadConfig(),
    fetchImpl: overrides.fetchImpl,
  };
}

// ---------------------------------------------------------------------------
// Shared source constants
// ---------------------------------------------------------------------------

const INDEX_SRC = (path: string): EnvelopeSource => ({
  label: 'Renaiss OS Index (beta)',
  url: `https://api.renaissos.com${path}`,
});

const RENAISS_SRC = (path: string): EnvelopeSource => ({
  label: 'Renaiss API (beta)',
  url: `https://api.renaiss.xyz${path}`,
});

const PULLCAST_SRC = (path: string, base: string): EnvelopeSource => ({
  label: 'PullCast API',
  url: `${base}${path}`,
});

// ---------------------------------------------------------------------------
// Input validators
// ---------------------------------------------------------------------------

const EVM_ADDRESS_RX = /^0x[a-fA-F0-9]{40}$/;

/**
 * Cert numbers are alphanumeric strings prefixed with the grader
 * (PSA, BGS, CGC, SGC). Reject anything with characters outside `[A-Za-z0-9]`.
 * Length cap protects against unbounded URL construction.
 */
const CERT_RX = /^[A-Za-z0-9]{4,32}$/;

/**
 * Renaiss tokenIds are decimal integer strings up to 78 digits (uint256).
 * We also accept short IDs (e.g. slugs) so `price` can take arbitrary
 * identifiers; the upstream will echo the error if it disagrees.
 */
const TOKENID_OR_ID_RX = /^[A-Za-z0-9._:-]{1,128}$/;

function assertAddress(address: string): void {
  if (!EVM_ADDRESS_RX.test(address)) {
    throw new Error(
      'Invalid wallet address. Expected 0x-prefixed 40 hex characters.'
    );
  }
}

function assertCert(cert: string): void {
  if (!CERT_RX.test(cert)) {
    throw new Error(
      'Invalid cert. Expected alphanumeric (e.g. PSA73628064), 4-32 chars.'
    );
  }
}

function assertTokenOrCert(id: string): void {
  if (!TOKENID_OR_ID_RX.test(id)) {
    throw new Error(
      'Invalid identifier. Expected alphanumeric or `.-_:`; up to 128 chars.'
    );
  }
}

function assertGame(game: string | undefined): asserts game is
  | 'pokemon'
  | 'one-piece'
  | 'sports'
  | undefined {
  if (game === undefined) return;
  if (game !== 'pokemon' && game !== 'one-piece' && game !== 'sports') {
    throw new Error(`Invalid --game. Must be one of: pokemon, one-piece, sports.`);
  }
}

// ---------------------------------------------------------------------------
// pullcast pull <address>
// ---------------------------------------------------------------------------

/**
 * Recent pulls for a wallet.
 *
 * Primary: PullCast backend at `/api/wallets/:address/pulls?limit=n`.
 * If the backend is unreachable, surface a clear error explaining that the
 * PullCast indexer is the only source of aggregated cross-pack pulls.
 */
export async function runPull(
  address: string,
  opts: { limit?: number } = {},
  ctx: CommandContext = makeContext()
): Promise<Envelope<{ address: string; pulls: PullLike[] }>> {
  assertAddress(address);
  const limit = opts.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Invalid --limit. Must be an integer in [1, 100].');
  }
  const path = `/api/wallets/${address}/pulls?limit=${limit}`;
  const url = `${ctx.config.pullcastApiUrl}${path}`;
  let raw: unknown;
  try {
    raw = await getJson(url, { fetchImpl: ctx.fetchImpl });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return envelope(
        { address, pulls: [] as PullLike[] },
        [PULLCAST_SRC(path, ctx.config.pullcastApiUrl)]
      );
    }
    throw err;
  }
  const pulls = extractPulls(raw);
  return envelope(
    { address, pulls },
    [PULLCAST_SRC(path, ctx.config.pullcastApiUrl)]
  );
}

function extractPulls(raw: unknown): PullLike[] {
  if (!raw || typeof raw !== 'object') return [];
  const rec = raw as Record<string, unknown>;
  // Backend envelope: { data: { pulls: [...] } } OR { pulls: [...] }
  const dataObj =
    rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, unknown>) : rec;
  const arr =
    Array.isArray(dataObj.pulls) ? dataObj.pulls
    : Array.isArray(dataObj.items) ? dataObj.items
    : Array.isArray(rec) ? (rec as unknown[])
    : [];
  const out: PullLike[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    out.push({
      id: typeof p.id === 'string' ? p.id : undefined,
      collectibleTokenId:
        typeof p.collectibleTokenId === 'string' ? p.collectibleTokenId : undefined,
      name: typeof p.name === 'string' ? p.name : undefined,
      tier: typeof p.tier === 'string' ? p.tier : null,
      fmvCents:
        typeof p.fmvCents === 'number'
          ? p.fmvCents
          : typeof p.fmv === 'number'
          ? p.fmv
          : null,
      pulledAtTimestamp:
        typeof p.pulledAtTimestamp === 'string' || typeof p.pulledAtTimestamp === 'number'
          ? p.pulledAtTimestamp
          : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// pullcast valuate <cert>
// ---------------------------------------------------------------------------

export async function runValuate(
  cert: string,
  ctx: CommandContext = makeContext()
): Promise<Envelope<GradedLike>> {
  assertCert(cert);
  const path = `/v1/graded/${encodeURIComponent(cert)}`;
  const url = `${ctx.config.renaissIndexUrl}${path}`;
  const raw = await getJson<Record<string, unknown>>(url, { fetchImpl: ctx.fetchImpl });
  const graded = normalizeGraded(cert, raw);
  return envelope(graded, [INDEX_SRC(path)]);
}

function normalizeGraded(cert: string, raw: Record<string, unknown>): GradedLike {
  const card =
    raw.card && typeof raw.card === 'object'
      ? (raw.card as Record<string, unknown>)
      : null;
  return {
    cert: typeof raw.cert === 'string' ? raw.cert : cert,
    found: typeof raw.found === 'boolean' ? raw.found : false,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    gradeLabel: typeof raw.gradeLabel === 'string' ? raw.gradeLabel : undefined,
    card: card
      ? {
          name: typeof card.name === 'string' ? card.name : undefined,
          setName: typeof card.setName === 'string' ? card.setName : undefined,
          priceUsdCents:
            typeof card.priceUsdCents === 'number' ? card.priceUsdCents : undefined,
          deltaPct: typeof card.deltaPct === 'number' ? card.deltaPct : undefined,
          confidence: typeof card.confidence === 'string' ? card.confidence : undefined,
          lastSaleAt: typeof card.lastSaleAt === 'string' ? card.lastSaleAt : undefined,
          href: typeof card.href === 'string' ? card.href : undefined,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// pullcast market [--game]
// ---------------------------------------------------------------------------

export async function runMarket(
  opts: { game?: 'pokemon' | 'one-piece' | 'sports' } = {},
  ctx: CommandContext = makeContext()
): Promise<Envelope<{ game: string | null; indices: TileLike[] }>> {
  assertGame(opts.game);
  const path = opts.game ? `/v1/indices/${opts.game}` : '/v1/indices';
  const url = `${ctx.config.renaissIndexUrl}${path}`;
  const raw = await getJson<Record<string, unknown>>(url, { fetchImpl: ctx.fetchImpl });
  const tiles = extractTiles(raw, opts.game ?? null);
  return envelope(
    { game: opts.game ?? null, indices: tiles },
    [INDEX_SRC(path)]
  );
}

function extractTiles(raw: Record<string, unknown>, gameFilter: string | null): TileLike[] {
  // /v1/indices -> { indices: [...] }
  // /v1/indices/{game} -> { game, value, deltas, constituents } (single tile-shaped)
  if (Array.isArray(raw.indices)) {
    return (raw.indices as unknown[]).map(normalizeTile).filter(Boolean) as TileLike[];
  }
  // Single-game shape: treat root as one tile.
  const single = normalizeTile(raw);
  if (single) return [{ ...single, game: single.game ?? gameFilter ?? undefined }];
  return [];
}

function normalizeTile(item: unknown): TileLike | null {
  if (!item || typeof item !== 'object') return null;
  const t = item as Record<string, unknown>;
  const deltas =
    t.deltas && typeof t.deltas === 'object' ? (t.deltas as Record<string, unknown>) : {};
  return {
    game: typeof t.game === 'string' ? t.game : undefined,
    value: typeof t.value === 'number' ? t.value : undefined,
    base: typeof t.base === 'number' ? t.base : undefined,
    deltas: {
      d7: typeof deltas.d7 === 'number' ? deltas.d7 : undefined,
      d30: typeof deltas.d30 === 'number' ? deltas.d30 : undefined,
      d365: typeof deltas.d365 === 'number' ? deltas.d365 : undefined,
    },
    constituentCount:
      typeof t.constituentCount === 'number' ? t.constituentCount : undefined,
  };
}

// ---------------------------------------------------------------------------
// pullcast featured [--limit=n]
// ---------------------------------------------------------------------------

export async function runFeatured(
  opts: { limit?: number } = {},
  ctx: CommandContext = makeContext()
): Promise<Envelope<{ limit: number; cards: FeaturedLike[] }>> {
  const limit = opts.limit ?? 6;
  if (!Number.isInteger(limit) || limit < 1 || limit > 24) {
    throw new Error('Invalid --limit. Must be an integer in [1, 24].');
  }
  const path = `/v1/cards/featured?limit=${limit}`;
  const url = `${ctx.config.renaissIndexUrl}${path}`;
  const raw = await getJson<Record<string, unknown>>(url, { fetchImpl: ctx.fetchImpl });
  const cards = extractFeatured(raw);
  return envelope({ limit, cards }, [INDEX_SRC('/v1/cards/featured')]);
}

function extractFeatured(raw: Record<string, unknown>): FeaturedLike[] {
  const arr = Array.isArray(raw.cards)
    ? (raw.cards as unknown[])
    : Array.isArray(raw.items)
    ? (raw.items as unknown[])
    : [];
  const out: FeaturedLike[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    out.push({
      name: typeof c.name === 'string' ? c.name : undefined,
      setName: typeof c.setName === 'string' ? c.setName : undefined,
      gradeLabel: typeof c.gradeLabel === 'string' ? c.gradeLabel : undefined,
      priceUsdCents: typeof c.priceUsdCents === 'number' ? c.priceUsdCents : undefined,
      deltaPct: typeof c.deltaPct === 'number' ? c.deltaPct : undefined,
      confidence: typeof c.confidence === 'string' ? c.confidence : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// pullcast price <tokenId-or-cert>
// ---------------------------------------------------------------------------

/**
 * Cross-source price blend.
 *
 * Heuristic:
 *  - Input matches /^(PSA|CGC|BGS|SGC)\d+$/ or clear cert shape -> Index cert lookup.
 *  - Otherwise treat as a Renaiss tokenId or arbitrary id -> query
 *    `${pullcastApiUrl}/api/price/token/:id`.
 *
 * The Renaiss main API is queried through PullCast to avoid duplicating the
 * blend logic. If the PullCast API is unreachable, we fall back to a direct
 * Index cert-shaped guess: assume the input IS a cert and try.
 */
export async function runPrice(
  input: string,
  ctx: CommandContext = makeContext()
): Promise<Envelope<PriceLike>> {
  assertTokenOrCert(input);
  const looksLikeCert = /^(PSA|CGC|BGS|SGC)\d+$/i.test(input);

  if (looksLikeCert) {
    const path = `/v1/graded/${encodeURIComponent(input)}`;
    const url = `${ctx.config.renaissIndexUrl}${path}`;
    const raw = await getJson<Record<string, unknown>>(url, { fetchImpl: ctx.fetchImpl });
    const graded = normalizeGraded(input, raw);
    return envelope(
      {
        input,
        indexFmvUsd:
          typeof graded.card?.priceUsdCents === 'number'
            ? graded.card.priceUsdCents / 100
            : null,
        renaissFmvUsd: null,
        confidence: graded.card?.confidence ?? null,
        variancePct: null,
        reason: graded.found ? null : graded.reason ?? 'not_found',
      },
      [INDEX_SRC(path)]
    );
  }

  const path = `/api/price/token/${encodeURIComponent(input)}`;
  const url = `${ctx.config.pullcastApiUrl}${path}`;
  const raw = await getJson<Record<string, unknown>>(url, { fetchImpl: ctx.fetchImpl });
  const p = normalizePriceBlend(input, raw);
  return envelope(p, [
    PULLCAST_SRC(path, ctx.config.pullcastApiUrl),
    INDEX_SRC('/v1/graded/{cert}'),
    RENAISS_SRC('/v0/cards/{tokenId}'),
  ]);
}

// ---------------------------------------------------------------------------
// pullcast packs [slug] [--include-inactive]
// ---------------------------------------------------------------------------

/**
 * Public metadata for a Renaiss card pack. Mirrors the fields the official
 * `renaiss packs` CLI prints (per file 17 §3 + verified 2026-07-03 against
 * `npx renaiss@0.0.2 packs`). Values are kept as raw strings so a bad upstream
 * cannot crash the CLI on a numeric parse mid-stream; the formatter parses
 * lazily and falls back to em-dashes on garbage.
 */
export interface PackLike {
  slug?: string;
  name?: string;
  packType?: string;
  stage?: string;
  description?: string | null;
  author?: string;
  priceInUsdt?: string;
  expectedValueInUsd?: string;
  featuredCardFmvInUsd?: string;
}

const PACK_SLUG_RX = /^[a-z0-9-]{1,64}$/i;

function assertPackSlug(slug: string): void {
  if (!PACK_SLUG_RX.test(slug)) {
    throw new Error(
      'Invalid pack slug. Expected lowercase letters, digits, or dashes; up to 64 chars.'
    );
  }
}

const stringOrUndefined = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

function normalizePack(raw: unknown): PackLike | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const asDigitString = (val: unknown): string | undefined => {
    if (typeof val === 'string') return val;
    if (typeof val === 'number' && Number.isFinite(val)) return String(val);
    return undefined;
  };
  return {
    slug: stringOrUndefined(p.slug),
    name: stringOrUndefined(p.name),
    packType: stringOrUndefined(p.packType),
    stage: stringOrUndefined(p.stage),
    description:
      typeof p.description === 'string'
        ? p.description
        : p.description === null
        ? null
        : undefined,
    author: stringOrUndefined(p.author),
    priceInUsdt: asDigitString(p.priceInUsdt),
    expectedValueInUsd: asDigitString(p.expectedValueInUsd),
    featuredCardFmvInUsd: asDigitString(p.featuredCardFmvInUsd),
  };
}

/**
 * `pullcast packs` mirror.
 *
 *  no slug          -> list all active packs. `--include-inactive` folds archived.
 *  slug provided    -> jump to detail via `/api/packs/{slug}` on the PullCast
 *                       backend (which itself proxies Renaiss main API).
 *
 * Backend path is intentionally used (rather than hitting Renaiss directly)
 * so rate limit, envelope, and cache all live in one place. The envelope
 * `sources` field cites both PullCast and the upstream Renaiss route so a
 * consumer inspecting the JSON can trace provenance.
 */
export async function runPacks(
  opts: { slug?: string; includeInactive?: boolean } = {},
  ctx: CommandContext = makeContext()
): Promise<Envelope<{ mode: 'list' | 'detail'; slug: string | null; packs: PackLike[] }>> {
  if (opts.slug !== undefined && opts.slug !== '') {
    assertPackSlug(opts.slug);
    const slug = opts.slug.toLowerCase();
    const path = `/api/packs/${encodeURIComponent(slug)}`;
    const url = `${ctx.config.pullcastApiUrl}${path}`;
    const raw = await getJson<Record<string, unknown>>(url, { fetchImpl: ctx.fetchImpl });
    const dataObj =
      raw.data && typeof raw.data === 'object'
        ? (raw.data as Record<string, unknown>)
        : raw;
    const packRaw =
      (dataObj.pack && typeof dataObj.pack === 'object' ? dataObj.pack : dataObj) as unknown;
    const pack = normalizePack(packRaw);
    return envelope(
      { mode: 'detail' as const, slug, packs: pack ? [pack] : [] },
      [
        PULLCAST_SRC(path, ctx.config.pullcastApiUrl),
        RENAISS_SRC(`/v0/packs/${slug}`),
      ]
    );
  }

  const qs = opts.includeInactive === true ? '?includeInactive=true' : '';
  const path = `/api/packs${qs}`;
  const url = `${ctx.config.pullcastApiUrl}${path}`;
  const raw = await getJson<Record<string, unknown>>(url, { fetchImpl: ctx.fetchImpl });
  const dataObj =
    raw.data && typeof raw.data === 'object'
      ? (raw.data as Record<string, unknown>)
      : raw;
  const arr = Array.isArray(dataObj.packs)
    ? (dataObj.packs as unknown[])
    : Array.isArray(dataObj.cardPacks)
    ? (dataObj.cardPacks as unknown[])
    : [];
  const packs = arr
    .map((entry) => normalizePack(entry))
    .filter((p): p is PackLike => p !== null);
  return envelope(
    { mode: 'list' as const, slug: null, packs },
    [PULLCAST_SRC(path, ctx.config.pullcastApiUrl), RENAISS_SRC('/v0/packs')]
  );
}

// ---------------------------------------------------------------------------
// pullcast gacha info <packSlug>
// ---------------------------------------------------------------------------

/**
 * Odds-blend shape for the `gacha info` read-only companion.
 *
 * We surface both windows verbatim from `/api/odds/:pack` (D8-M4). The upstream
 * block is the last ~30 pulls Renaiss returns; the empirical block is our own
 * indexed 90d aggregate. `divergence[]` is per-tier delta (percentage points).
 *
 * PackDetail comes straight from `/api/packs/:slug` (D8 pack-detail route).
 * We do NOT recompute prices client-side, only reshape.
 */
export interface PackInfoBlend {
  pack: PackLike;
  odds: {
    upstream_recent: {
      source: string;
      sampleSize: number;
      tierFrequency: Array<{ tier: string; count: number; pct: number }>;
      error: string | null;
    };
    empirical_90d: {
      source: string;
      windowDays: number;
      totalPulls: number;
      insufficientSample: boolean;
      minSample: number;
      tierFrequency: Array<{ tier: string; count: number; pct: number }>;
      error: string | null;
    };
    divergence: Array<{
      tier: string;
      upstreamPct: number;
      empiricalPct: number;
      deltaPct: number;
      flagged: boolean;
    }>;
  };
}

/**
 * `pullcast gacha info <slug>` — read-only pack detail with odds blend.
 *
 * Fetches both `/api/packs/:slug` (pack metadata) and `/api/odds/:slug` (odds
 * dual-window) in parallel, then merges into a single envelope. Sources cite
 * BOTH Renaiss main API and the PullCast indexer.
 *
 * If `/api/odds/:slug` returns 404 (pack is not indexer-tracked), we still
 * return the pack detail with an empty odds block and a warning marker so
 * callers see the reason. Pack-not-found from `/api/packs/:slug` is fatal.
 */
export async function runPackInfo(
  slug: string,
  ctx: CommandContext = makeContext()
): Promise<Envelope<PackInfoBlend>> {
  assertPackSlug(slug);
  const normalizedSlug = slug.toLowerCase();
  const packPath = `/api/packs/${encodeURIComponent(normalizedSlug)}`;
  const oddsPath = `/api/odds/${encodeURIComponent(normalizedSlug)}`;
  const packUrl = `${ctx.config.pullcastApiUrl}${packPath}`;
  const oddsUrl = `${ctx.config.pullcastApiUrl}${oddsPath}`;

  const [packSettled, oddsSettled] = await Promise.allSettled([
    getJson<Record<string, unknown>>(packUrl, { fetchImpl: ctx.fetchImpl }),
    getJson<Record<string, unknown>>(oddsUrl, { fetchImpl: ctx.fetchImpl }),
  ]);

  if (packSettled.status === 'rejected') {
    throw packSettled.reason;
  }

  const packRaw = packSettled.value;
  const packDataObj =
    packRaw.data && typeof packRaw.data === 'object'
      ? (packRaw.data as Record<string, unknown>)
      : packRaw;
  const packInner =
    (packDataObj.pack && typeof packDataObj.pack === 'object'
      ? packDataObj.pack
      : packDataObj) as unknown;
  const pack = normalizePack(packInner) ?? { slug: normalizedSlug };

  const emptyOdds: PackInfoBlend['odds'] = {
    upstream_recent: {
      source:
        'Renaiss main API GET /v0/packs/{slug}.cardPack.recentOpenedPacks',
      sampleSize: 0,
      tierFrequency: [],
      error: null,
    },
    empirical_90d: {
      source: 'PullCast indexer (trailing 90d, tracked packs only)',
      windowDays: 90,
      totalPulls: 0,
      insufficientSample: true,
      minSample: 10,
      tierFrequency: [],
      error: null,
    },
    divergence: [],
  };

  let odds: PackInfoBlend['odds'] = emptyOdds;
  if (oddsSettled.status === 'fulfilled') {
    const oddsRaw = oddsSettled.value;
    const oddsDataObj =
      oddsRaw.data && typeof oddsRaw.data === 'object'
        ? (oddsRaw.data as Record<string, unknown>)
        : oddsRaw;
    odds = normalizeOdds(oddsDataObj, emptyOdds);
  } else if (
    oddsSettled.reason instanceof HttpError &&
    oddsSettled.reason.status === 404
  ) {
    // Pack is not tracked by the indexer. Leave odds empty; upstream_recent
    // error is set below so the pretty formatter can render "not tracked".
    odds = {
      ...emptyOdds,
      upstream_recent: {
        ...emptyOdds.upstream_recent,
        error: 'Pack not tracked by PullCast indexer',
      },
    };
  } else if (oddsSettled.status === 'rejected') {
    // Non-404 fetch error is non-fatal — pack detail still renders. Surface
    // the failure via the error field only; do not throw.
    const msg =
      oddsSettled.reason instanceof Error
        ? oddsSettled.reason.message
        : 'Odds fetch failed';
    odds = {
      ...emptyOdds,
      upstream_recent: { ...emptyOdds.upstream_recent, error: msg },
      empirical_90d: { ...emptyOdds.empirical_90d, error: msg },
    };
  }

  return envelope(
    { pack, odds },
    [
      PULLCAST_SRC(packPath, ctx.config.pullcastApiUrl),
      PULLCAST_SRC(oddsPath, ctx.config.pullcastApiUrl),
      RENAISS_SRC(`/v0/packs/${normalizedSlug}`),
    ]
  );
}

const asTierFrequency = (
  raw: unknown
): Array<{ tier: string; count: number; pct: number }> => {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ tier: string; count: number; pct: number }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    if (typeof t.tier !== 'string') continue;
    out.push({
      tier: t.tier,
      count: typeof t.count === 'number' ? t.count : 0,
      pct: typeof t.pct === 'number' ? t.pct : 0,
    });
  }
  return out;
};

const asDivergence = (
  raw: unknown
): Array<{
  tier: string;
  upstreamPct: number;
  empiricalPct: number;
  deltaPct: number;
  flagged: boolean;
}> => {
  if (!Array.isArray(raw)) return [];
  const out: Array<{
    tier: string;
    upstreamPct: number;
    empiricalPct: number;
    deltaPct: number;
    flagged: boolean;
  }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    if (typeof t.tier !== 'string') continue;
    out.push({
      tier: t.tier,
      upstreamPct: typeof t.upstreamPct === 'number' ? t.upstreamPct : 0,
      empiricalPct: typeof t.empiricalPct === 'number' ? t.empiricalPct : 0,
      deltaPct: typeof t.deltaPct === 'number' ? t.deltaPct : 0,
      flagged: t.flagged === true,
    });
  }
  return out;
};

function normalizeOdds(
  raw: Record<string, unknown>,
  fallback: PackInfoBlend['odds']
): PackInfoBlend['odds'] {
  const up =
    raw.upstream_recent && typeof raw.upstream_recent === 'object'
      ? (raw.upstream_recent as Record<string, unknown>)
      : {};
  const emp =
    raw.empirical_90d && typeof raw.empirical_90d === 'object'
      ? (raw.empirical_90d as Record<string, unknown>)
      : {};

  return {
    upstream_recent: {
      source:
        typeof up.source === 'string'
          ? up.source
          : fallback.upstream_recent.source,
      sampleSize: typeof up.sampleSize === 'number' ? up.sampleSize : 0,
      tierFrequency: asTierFrequency(up.tierFrequency),
      error: typeof up.error === 'string' ? up.error : null,
    },
    empirical_90d: {
      source:
        typeof emp.source === 'string'
          ? emp.source
          : fallback.empirical_90d.source,
      windowDays: typeof emp.windowDays === 'number' ? emp.windowDays : 90,
      totalPulls: typeof emp.totalPulls === 'number' ? emp.totalPulls : 0,
      insufficientSample:
        typeof emp.insufficientSample === 'boolean'
          ? emp.insufficientSample
          : true,
      minSample: typeof emp.minSample === 'number' ? emp.minSample : 10,
      tierFrequency: asTierFrequency(emp.tierFrequency),
      error: typeof emp.error === 'string' ? emp.error : null,
    },
    divergence: asDivergence(raw.divergence),
  };
}

// ---------------------------------------------------------------------------
// pullcast marketplace (mirror of `npx renaiss marketplace`)
// ---------------------------------------------------------------------------

/**
 * Flag set mirrors the official CLI 1:1 (verified against `npx renaiss@0.0.2
 * marketplace --help`). CLI flag names -> backend query param names are mapped
 * here so callers can pass the same flags they'd pass to `renaiss marketplace`.
 */
/**
 * Flag set as of Renaiss CLI 0.0.3-beta.2 (2026-07-05). The `--character` flag
 * was REMOVED upstream in 0.0.3-beta.2, so we drop it from the CLI surface too
 * to preserve strict verb-tree parity.
 *
 * The backend `/api/marketplace` route still accepts `characterFilter=` for
 * backward-compat with older Discord command / web callers (see
 * marketplaceRoutes.ts); only the CLI-side flag is retired.
 */
export interface MarketplaceOpts {
  search?: string;
  category?: string;
  listed?: boolean;
  language?: string;
  grading?: string;
  grade?: string;
  year?: string;
  price?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

const MARKETPLACE_CATEGORIES = new Set(['POKEMON', 'ONE_PIECE']);
const MARKETPLACE_GRADERS = new Set(['PSA', 'BGS', 'CGC', 'SGC']);
const MARKETPLACE_SORTS = new Set([
  'fmvPriceInUsd',
  'year',
  'grade',
  'name',
  'listDate',
  'mintDate',
]);
const MARKETPLACE_ORDERS = new Set(['asc', 'desc']);

// Free-text length caps. Mirrors what marketplaceRoutes.ts enforces so the
// CLI-side error is surfaced BEFORE a network round-trip.
const MP_SEARCH_MIN = 3;
const MP_SEARCH_MAX = 150;
const MP_FIELD_MAX = 64;
const YEAR_RANGE_RX = /^\d{4}(-\d{4})?$/;
const PRICE_RANGE_RX = /^\d+(-\d+)?$/;
// Character/language are free-form user strings passed straight through. Cap
// to a sane bound + reject control characters to keep the query URL safe.
const SAFE_TEXT_RX = /^[^\x00-\x1f\x7f]{1,64}$/;

export async function runMarketplace(
  opts: MarketplaceOpts = {},
  ctx: CommandContext = makeContext()
): Promise<
  Envelope<{
    collection: MarketplaceRowLike[];
    pagination: MarketplacePaginationLike;
  }>
> {
  const qs = new URLSearchParams();

  if (opts.search !== undefined) {
    const s = opts.search.trim();
    if (s.length < MP_SEARCH_MIN || s.length > MP_SEARCH_MAX) {
      throw new Error(
        `--search must be ${MP_SEARCH_MIN}..${MP_SEARCH_MAX} characters.`
      );
    }
    qs.set('search', s);
  }

  if (opts.category !== undefined) {
    const c = opts.category.trim().toUpperCase();
    if (!MARKETPLACE_CATEGORIES.has(c)) {
      throw new Error(
        `--category must be one of: ${Array.from(MARKETPLACE_CATEGORIES).join(', ')}.`
      );
    }
    qs.set('categoryFilter', c);
  }

  if (opts.listed === true) qs.set('listedOnly', 'true');

  if (opts.language !== undefined) {
    if (!SAFE_TEXT_RX.test(opts.language)) {
      throw new Error('--language contains invalid characters or is empty.');
    }
    qs.set('languageFilter', opts.language);
  }

  if (opts.grading !== undefined) {
    const g = opts.grading.trim().toUpperCase();
    if (!MARKETPLACE_GRADERS.has(g)) {
      throw new Error(
        `--grading must be one of: ${Array.from(MARKETPLACE_GRADERS).join(', ')}.`
      );
    }
    qs.set('gradingCompanyFilter', g);
  }

  if (opts.grade !== undefined) {
    if (opts.grade.length === 0 || opts.grade.length > MP_FIELD_MAX) {
      throw new Error(`--grade must be 1..${MP_FIELD_MAX} chars.`);
    }
    qs.set('gradeFilter', opts.grade);
  }

  if (opts.year !== undefined) {
    if (!YEAR_RANGE_RX.test(opts.year)) {
      throw new Error('--year must look like "2023" or "2020-2025".');
    }
    qs.set('yearRange', opts.year);
  }

  if (opts.price !== undefined) {
    if (!PRICE_RANGE_RX.test(opts.price)) {
      throw new Error('--price must look like "1000" or "1000-50000".');
    }
    qs.set('priceRangeFilter', opts.price);
  }

  if (opts.sort !== undefined) {
    if (!MARKETPLACE_SORTS.has(opts.sort)) {
      throw new Error(
        `--sort must be one of: ${Array.from(MARKETPLACE_SORTS).join(', ')}.`
      );
    }
    qs.set('sortBy', opts.sort);
  }

  if (opts.order !== undefined) {
    if (!MARKETPLACE_ORDERS.has(opts.order)) {
      throw new Error('--order must be asc or desc.');
    }
    qs.set('sortOrder', opts.order);
  }

  const limit = opts.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('--limit must be an integer in [1, 100].');
  }
  qs.set('limit', String(limit));

  const offset = opts.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('--offset must be a non-negative integer.');
  }
  if (offset !== 0) qs.set('offset', String(offset));

  const path = `/api/marketplace?${qs.toString()}`;
  const url = `${ctx.config.pullcastApiUrl}${path}`;
  const raw = await getJson<Record<string, unknown>>(url, {
    fetchImpl: ctx.fetchImpl,
  });
  const { collection, pagination } = extractMarketplace(raw, limit, offset);
  return envelope(
    { collection, pagination },
    [
      PULLCAST_SRC('/api/marketplace', ctx.config.pullcastApiUrl),
      RENAISS_SRC('/v0/marketplace'),
    ]
  );
}

/**
 * Backend response shape (D8 envelope): `{ success, error, data: { collection,
 * pagination, _disclosure }, sources, warnings, generated_at }`. We accept
 * either the enveloped shape or a bare `{ collection, pagination }` (matches
 * the raw upstream shape) so the CLI degrades gracefully across contract
 * revisions.
 */
function extractMarketplace(
  raw: Record<string, unknown>,
  limit: number,
  offset: number
): { collection: MarketplaceRowLike[]; pagination: MarketplacePaginationLike } {
  const dataObj =
    raw.data && typeof raw.data === 'object'
      ? (raw.data as Record<string, unknown>)
      : raw;
  const rawCollection = Array.isArray(dataObj.collection)
    ? (dataObj.collection as unknown[])
    : [];
  const collection: MarketplaceRowLike[] = [];
  for (const item of rawCollection) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    collection.push({
      tokenId: typeof row.tokenId === 'string' ? row.tokenId : undefined,
      name: typeof row.name === 'string' ? row.name : undefined,
      setName: typeof row.setName === 'string' ? row.setName : undefined,
      grade: typeof row.grade === 'string' ? row.grade : undefined,
      gradingCompany:
        typeof row.gradingCompany === 'string' ? row.gradingCompany : undefined,
      // Upstream sends both prices as decimal strings. fmvPriceInUSD is USD
      // cents as a string; askPriceInUSDT is a raw base-1e18 uint256 string.
      fmvPriceInUSD:
        typeof row.fmvPriceInUSD === 'string' ? row.fmvPriceInUSD : undefined,
      askPriceInUSDT:
        typeof row.askPriceInUSDT === 'string' ? row.askPriceInUSDT : undefined,
      year: typeof row.year === 'number' ? row.year : undefined,
    });
  }

  const rawPag =
    dataObj.pagination && typeof dataObj.pagination === 'object'
      ? (dataObj.pagination as Record<string, unknown>)
      : {};
  const pagination: MarketplacePaginationLike = {
    total: typeof rawPag.total === 'number' ? rawPag.total : collection.length,
    limit: typeof rawPag.limit === 'number' ? rawPag.limit : limit,
    offset: typeof rawPag.offset === 'number' ? rawPag.offset : offset,
    hasMore: typeof rawPag.hasMore === 'boolean' ? rawPag.hasMore : false,
  };
  return { collection, pagination };
}

// ---------------------------------------------------------------------------
// pullcast card <tokenId> (mirror of `npx renaiss card`)
// ---------------------------------------------------------------------------

/**
 * Renaiss tokenIds are decimal uint256 strings (up to 78 digits). We accept
 * anything alphanumeric up to 128 chars so slug ids won't be rejected here;
 * the backend validator does the final tokenId regex check.
 */
const CARD_TOKEN_RX = /^[A-Za-z0-9]{1,128}$/;

export interface CardOpts {
  price?: boolean;
  activities?: boolean;
  verbose?: boolean;
}

export async function runCard(
  tokenId: string,
  opts: CardOpts = {},
  ctx: CommandContext = makeContext()
): Promise<Envelope<CardBlendLike>> {
  if (!CARD_TOKEN_RX.test(tokenId)) {
    throw new Error(
      'Invalid tokenId. Expected alphanumeric, 1..128 chars.'
    );
  }
  const includePrice = opts.price !== false; // default: include price info
  const path = `/api/price/token/${encodeURIComponent(tokenId)}`;
  const url = `${ctx.config.pullcastApiUrl}${path}`;
  const raw = await getJson<Record<string, unknown>>(url, {
    fetchImpl: ctx.fetchImpl,
  });
  const card = extractCard(tokenId, raw, {
    includePrice,
    verbose: opts.verbose === true,
    activities: opts.activities === true,
  });
  return envelope(card, [
    PULLCAST_SRC(path, ctx.config.pullcastApiUrl),
    RENAISS_SRC('/v0/collectibles/{tokenId}'),
    INDEX_SRC('/v1/graded/{cert}'),
  ]);
}

/**
 * The /api/price/token/:id backend response already blends Renaiss main +
 * Renaiss Index + on-chain last sale. We surface exactly those fields (never
 * pass-through the entire envelope) so the CLI contract is stable even if the
 * backend adds new fields later.
 */
function extractCard(
  tokenId: string,
  raw: Record<string, unknown>,
  flags: { includePrice: boolean; verbose: boolean; activities: boolean }
): CardBlendLike {
  const data =
    raw.data && typeof raw.data === 'object'
      ? (raw.data as Record<string, unknown>)
      : raw;
  const onchainRaw =
    data.lastSaleOnChain && typeof data.lastSaleOnChain === 'object'
      ? (data.lastSaleOnChain as Record<string, unknown>)
      : null;

  const out: CardBlendLike = {
    tokenId,
    cardName: typeof data.cardName === 'string' ? data.cardName : null,
    setName: typeof data.setName === 'string' ? data.setName : null,
    cardNumber: typeof data.cardNumber === 'string' ? data.cardNumber : null,
    gradingCompany:
      typeof data.gradingCompany === 'string' ? data.gradingCompany : null,
    grade: typeof data.grade === 'string' ? data.grade : null,
    serial: typeof data.serial === 'string' ? data.serial : null,
    imageUrl: typeof data.imageUrl === 'string' ? data.imageUrl : null,
    price: null,
    activities: null,
  };

  if (flags.includePrice) {
    const main =
      typeof data.mainApiFmvUsdCents === 'number'
        ? data.mainApiFmvUsdCents
        : null;
    const idx =
      typeof data.indexApiFmvUsdCents === 'number'
        ? data.indexApiFmvUsdCents
        : null;
    const rec =
      typeof data.recommendedFmvUsdCents === 'number'
        ? data.recommendedFmvUsdCents
        : null;
    const confidence =
      typeof data.confidence === 'string' ? data.confidence : null;
    const lastSaleAt =
      typeof data.lastSaleAt === 'string' ? data.lastSaleAt : null;
    const varianceHigh =
      typeof data.variancePctOver20 === 'boolean'
        ? data.variancePctOver20
        : false;

    out.price = {
      mainApiFmvUsdCents: main,
      indexApiFmvUsdCents: idx,
      recommendedFmvUsdCents: rec,
      confidence,
      lastSaleAt,
      variancePctOver20: varianceHigh,
      onChainLastSale: onchainRaw
        ? {
            priceUsdcFormatted:
              typeof onchainRaw.priceUsdcFormatted === 'string'
                ? onchainRaw.priceUsdcFormatted
                : null,
            paymentToken:
              typeof onchainRaw.paymentToken === 'string'
                ? onchainRaw.paymentToken
                : null,
            txHash:
              typeof onchainRaw.txHash === 'string' ? onchainRaw.txHash : null,
            blockNumber:
              typeof onchainRaw.blockNumber === 'number'
                ? onchainRaw.blockNumber
                : null,
            timestamp:
              typeof onchainRaw.timestamp === 'number'
                ? onchainRaw.timestamp
                : null,
            bscscanUrl:
              typeof onchainRaw.bscscanUrl === 'string'
                ? onchainRaw.bscscanUrl
                : null,
          }
        : null,
    };

    if (flags.verbose) {
      // Extended debug fields: include cert and card-shape identifiers alongside
      // the source URLs so power users can trace every value back to origin.
      out.price.sourceUrls = {
        renaissMainCard: `https://api.renaiss.xyz/v0/collectibles/${encodeURIComponent(tokenId)}`,
        renaissIndexCert:
          out.serial !== null
            ? `https://api.renaissos.com/v1/graded/${encodeURIComponent(out.serial.toUpperCase())}`
            : null,
        bscscan: out.price.onChainLastSale?.bscscanUrl ?? null,
      };
    }
  }

  if (flags.activities) {
    // Backend does not currently expose activities on /api/price/token/:id.
    // We surface an empty array + a `_reason` marker so the CLI contract is
    // ready for when the field lands and consumers do not break on the
    // transition. Do NOT invent activities.
    out.activities = {
      items: [],
      _reason: 'activities_not_available_via_price_endpoint',
    };
  }

  return out;
}

function normalizePriceBlend(input: string, raw: Record<string, unknown>): PriceLike {
  const dataObj =
    raw.data && typeof raw.data === 'object' ? (raw.data as Record<string, unknown>) : raw;
  const idx =
    dataObj.index && typeof dataObj.index === 'object'
      ? (dataObj.index as Record<string, unknown>)
      : {};
  const ren =
    dataObj.renaiss && typeof dataObj.renaiss === 'object'
      ? (dataObj.renaiss as Record<string, unknown>)
      : {};
  const indexUsd =
    typeof idx.priceUsd === 'number'
      ? idx.priceUsd
      : typeof idx.priceUsdCents === 'number'
      ? idx.priceUsdCents / 100
      : null;
  const renaissUsd =
    typeof ren.fmvUsd === 'number'
      ? ren.fmvUsd
      : typeof ren.fmvPriceInUSD === 'string'
      ? Number(ren.fmvPriceInUSD) / 100
      : null;
  return {
    input,
    indexFmvUsd: indexUsd,
    renaissFmvUsd: renaissUsd,
    confidence: typeof idx.confidence === 'string' ? idx.confidence : null,
    variancePct:
      typeof dataObj.variancePct === 'number' ? dataObj.variancePct : null,
    reason: typeof dataObj.reason === 'string' ? dataObj.reason : null,
  };
}

// ---------------------------------------------------------------------------
// pullcast trades [--limit] — Renaiss OS Index /v1/trades/recent
// ---------------------------------------------------------------------------

export interface TradeLike {
  observedAt?: string;
  priceUsdCents?: number | null;
  gradeLabel?: string | null;
  displayName?: string;
  card?: {
    name?: string;
    setCode?: string | null;
    cardNumber?: string | null;
    game?: string;
  };
}

function extractTrades(raw: Record<string, unknown>): TradeLike[] {
  const arr = Array.isArray(raw.trades)
    ? (raw.trades as unknown[])
    : Array.isArray(raw.items)
      ? (raw.items as unknown[])
      : [];
  const out: TradeLike[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const card =
      t.card && typeof t.card === 'object'
        ? (t.card as Record<string, unknown>)
        : null;
    out.push({
      observedAt: typeof t.observedAt === 'string' ? t.observedAt : undefined,
      priceUsdCents:
        typeof t.priceUsdCents === 'number' ? t.priceUsdCents : undefined,
      gradeLabel: typeof t.gradeLabel === 'string' ? t.gradeLabel : undefined,
      displayName: typeof t.displayName === 'string' ? t.displayName : undefined,
      card: card
        ? {
            name: typeof card.name === 'string' ? card.name : undefined,
            setCode: typeof card.setCode === 'string' ? card.setCode : undefined,
            cardNumber:
              typeof card.cardNumber === 'string' ? card.cardNumber : undefined,
            game: typeof card.game === 'string' ? card.game : undefined,
          }
        : undefined,
    });
  }
  return out;
}

export async function runTrades(
  opts: { limit?: number } = {},
  ctx: CommandContext = makeContext()
): Promise<Envelope<{ limit: number; trades: TradeLike[] }>> {
  const limit = opts.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('Invalid --limit. Must be an integer in [1, 50].');
  }
  const path = `/v1/trades/recent?limit=${limit}`;
  const url = `${ctx.config.renaissIndexUrl}${path}`;
  const raw = await getJson<Record<string, unknown>>(url, { fetchImpl: ctx.fetchImpl });
  const trades = extractTrades(raw);
  return envelope({ limit, trades }, [INDEX_SRC('/v1/trades/recent')]);
}

// ---------------------------------------------------------------------------
// pullcast report --reason "..." [--cert PSA...] [--token <id>]
// Forwards to Renaiss OS Index /v1/report via PullCast API.
// ---------------------------------------------------------------------------

export async function runReport(
  opts: { reason: string; cert?: string; tokenId?: string; evidence?: string },
  ctx: CommandContext = makeContext()
): Promise<Envelope<{ received: boolean; reportId?: string }>> {
  const reason = opts.reason?.trim();
  if (!reason || reason.length > 2000) {
    throw new Error('--reason is required (1-2000 chars).');
  }
  const card: Record<string, string> = {};
  if (opts.cert) card.cert = opts.cert.trim().toUpperCase();
  if (opts.tokenId) card.tokenId = opts.tokenId.trim();

  const body = {
    reason,
    evidence: opts.evidence,
    ...(Object.keys(card).length > 0 ? { card } : {}),
  };

  const url = `${ctx.config.pullcastApiUrl}/api/report`;
  const res = await (ctx.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || json.success === false) {
    const err = json.error as { message?: string } | undefined;
    throw new Error(err?.message ?? `Report failed (${res.status})`);
  }
  const data = (json.data ?? {}) as Record<string, unknown>;
  return envelope(
    {
      received: data.received === true,
      reportId: typeof data.reportId === 'string' ? data.reportId : undefined,
    },
    [
      {
        label: 'Renaiss OS Index report (beta)',
        url: 'https://api.renaissos.com/v1/report',
      },
    ]
  );
}

// ---------------------------------------------------------------------------
// pullcast search <query> — Renaiss OS Index /v1/search
// ---------------------------------------------------------------------------

export interface SearchResultLike {
  name?: string;
  setName?: string;
  cardNumber?: string;
  gradeLabel?: string;
  priceUsdCents?: number | null;
  confidence?: string;
  href?: string;
  game?: string;
}

function extractSearchResults(raw: Record<string, unknown>): SearchResultLike[] {
  const arr = Array.isArray(raw.results)
    ? (raw.results as unknown[])
    : Array.isArray(raw.items)
      ? (raw.items as unknown[])
      : [];
  const out: SearchResultLike[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    out.push({
      name: typeof r.name === 'string' ? r.name : undefined,
      setName: typeof r.setName === 'string' ? r.setName : undefined,
      cardNumber: typeof r.cardNumber === 'string' ? r.cardNumber : undefined,
      gradeLabel: typeof r.gradeLabel === 'string' ? r.gradeLabel : undefined,
      priceUsdCents:
        typeof r.priceUsdCents === 'number' ? r.priceUsdCents : undefined,
      confidence: typeof r.confidence === 'string' ? r.confidence : undefined,
      href: typeof r.href === 'string' ? r.href : undefined,
      game: typeof r.game === 'string' ? r.game : undefined,
    });
  }
  return out;
}

export async function runSearch(
  query: string,
  opts: { limit?: number; game?: string; set?: string } = {},
  ctx: CommandContext = makeContext()
): Promise<Envelope<{ query: string; limit: number; results: SearchResultLike[] }>> {
  const q = query.trim();
  if (q.length < 2) {
    throw new Error('Search query must be at least 2 characters.');
  }
  const limit = opts.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('Invalid --limit. Must be an integer in [1, 50].');
  }
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (opts.game) params.set('game', opts.game.trim());
  if (opts.set) params.set('set', opts.set.trim());
  const path = `/v1/search?${params.toString()}`;
  const url = `${ctx.config.renaissIndexUrl}${path}`;
  const raw = await getJson<Record<string, unknown>>(url, { fetchImpl: ctx.fetchImpl });
  const results = extractSearchResults(raw);
  return envelope({ query: q, limit, results }, [INDEX_SRC('/v1/search')]);
}

// ---------------------------------------------------------------------------
// pullcast set <game> <set> — Renaiss OS Index set listing
// ---------------------------------------------------------------------------

export interface SetCardLike {
  name?: string;
  gradeLabel?: string;
  priceUsdCents?: number | null;
  confidence?: string;
}

export interface SetListingLike {
  game: string;
  setName?: string | null;
  cardCount?: number;
  cards: SetCardLike[];
}

function extractSetListing(raw: Record<string, unknown>): SetListingLike {
  const cardsRaw = Array.isArray(raw.cards) ? (raw.cards as unknown[]) : [];
  const cards: SetCardLike[] = [];
  for (const item of cardsRaw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    cards.push({
      name: typeof c.name === 'string' ? c.name : undefined,
      gradeLabel: typeof c.gradeLabel === 'string' ? c.gradeLabel : undefined,
      priceUsdCents:
        typeof c.priceUsdCents === 'number' ? c.priceUsdCents : undefined,
      confidence: typeof c.confidence === 'string' ? c.confidence : undefined,
    });
  }
  return {
    game: typeof raw.game === 'string' ? raw.game : '',
    setName: typeof raw.setName === 'string' ? raw.setName : null,
    cardCount: typeof raw.cardCount === 'number' ? raw.cardCount : cards.length,
    cards,
  };
}

export async function runSet(
  game: string,
  setSlug: string,
  ctx: CommandContext = makeContext()
): Promise<Envelope<SetListingLike>> {
  const g = game.trim().toLowerCase();
  const set = setSlug.trim().toLowerCase();
  if (!['pokemon', 'one-piece', 'sports'].includes(g)) {
    throw new Error('Invalid game. Must be pokemon | one-piece | sports.');
  }
  if (!/^[a-z0-9-]{1,120}$/.test(set)) {
    throw new Error('Invalid set slug.');
  }
  const path = `/v1/sets/${encodeURIComponent(g)}/${encodeURIComponent(set)}`;
  const url = `${ctx.config.renaissIndexUrl}${path}`;
  const raw = await getJson<Record<string, unknown>>(url, { fetchImpl: ctx.fetchImpl });
  const listing = extractSetListing(raw);
  return envelope(listing, [INDEX_SRC(`/v1/sets/{game}/{set}`)]);
}

/**
 * Source retriever for /explain and /listing.
 *
 * Combines live API calls (cert lookup, card overview, recent trades) with the
 * static corpus seeds. Returns a flat array of `Source` objects that the
 * prompt builder will wrap in `<source-N>` blocks for the model to cite.
 *
 * Hard rule: the caller MUST refuse to call Anthropic when `sources.length <
 * 2`. The retriever logs but does not enforce that rule itself.
 */

import {
  getOrFetchCert,
  IndexApiError,
  renaissIndex,
} from '../renaiss-index/index.ts';
import { renaissApi, RenaissApiError } from '../renaiss/index.ts';
import { scoreCorpus } from './corpus-seeds.ts';

const LOG_PREFIX = '[retriever]';

/**
 * Source object passed to the prompt builder and surfaced to the user.
 */
export interface Source {
  id: number; // [source-N] citation index, 1-based
  name: string; // human-readable
  url: string; // canonical URL
  excerpt: string; // 200-400 chars max
  confidence?: 'high' | 'medium' | 'low';
  fetchedAt: string; // ISO
}

const EXCERPT_MAX = 400;
const EXCERPT_MIN = 200;

const trimExcerpt = (text: string): string => {
  if (typeof text !== 'string') return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= EXCERPT_MAX) return collapsed;
  return collapsed.slice(0, EXCERPT_MAX - 1).trimEnd() + '…';
};

const nowIso = (): string => new Date().toISOString();

/**
 * Extract the serial / cert id from a Renaiss main API card response. Mirrors
 * the same logic in `priceRoutes.ts` and `commands/price.ts`. Kept inline to
 * avoid a wider refactor.
 */
const extractSerial = (card: unknown): string | null => {
  if (typeof card !== 'object' || card === null) return null;
  const c = card as Record<string, unknown>;
  if (typeof c.serial === 'string' && c.serial.length > 0) return c.serial;
  if (Array.isArray(c.attributes)) {
    for (const a of c.attributes) {
      if (typeof a !== 'object' || a === null) continue;
      const t = (a as { trait_type?: unknown }).trait_type;
      const v = (a as { value?: unknown }).value;
      if (typeof t !== 'string') continue;
      const lower = t.toLowerCase();
      if (
        (lower === 'serial' ||
          lower === 'cert' ||
          lower === 'cert number' ||
          lower === 'certification') &&
        typeof v === 'string' &&
        v.length > 0
      ) {
        return v;
      }
    }
  }
  return null;
};

/**
 * Pull the Index API card.id out of a graded-lookup payload. Per the cache
 * schema the field is opaque-string; we accept any non-empty string.
 */
const extractCardIdFromCert = (cert: unknown): string | null => {
  if (typeof cert !== 'object' || cert === null) return null;
  const c = cert as Record<string, unknown>;
  const card = c.card;
  if (typeof card !== 'object' || card === null) return null;
  const id = (card as Record<string, unknown>).id;
  if (typeof id === 'string' && id.length > 0) return id;
  const cardId = (card as Record<string, unknown>).cardId;
  if (typeof cardId === 'string' && cardId.length > 0) return cardId;
  return null;
};

/**
 * Build a one-paragraph excerpt of a cert lookup. Includes price, confidence,
 * last sale at, and the grading details.
 */
const certExcerpt = (cert: string, lookup: unknown): string => {
  if (typeof lookup !== 'object' || lookup === null) return '';
  const l = lookup as Record<string, unknown>;
  if (l.found !== true) {
    const reason = typeof l.reason === 'string' ? l.reason : 'unknown';
    return `Cert ${cert}: not found (${reason}).`;
  }
  const card = (l.card ?? {}) as Record<string, unknown>;
  const name = typeof card.name === 'string' ? card.name : 'unknown card';
  const set = typeof card.setName === 'string' ? card.setName : null;
  const grade = typeof card.grade === 'string' ? card.grade : null;
  const grader = typeof card.gradingCompany === 'string' ? card.gradingCompany : null;
  const priceUsdCents =
    typeof card.priceUsdCents === 'number' ? card.priceUsdCents : null;
  const confidence = typeof card.confidence === 'string' ? card.confidence : null;
  const lastSaleAt = typeof card.lastSaleAt === 'string' ? card.lastSaleAt : null;
  const priceStr =
    priceUsdCents !== null
      ? `$${(priceUsdCents / 100).toFixed(2)}`
      : 'price unknown';

  return trimExcerpt(
    `${name}${set ? ` from ${set}` : ''}${grader ? ` graded ${grader}${grade ? ` ${grade}` : ''}` : ''}. Cert ${cert} priced at ${priceStr}${confidence ? ` (${confidence} confidence)` : ''}${lastSaleAt ? `, last sale ${lastSaleAt}` : ''}.`
  );
};

const overviewExcerpt = (overview: unknown): string => {
  if (typeof overview !== 'object' || overview === null) return '';
  const o = overview as Record<string, unknown>;
  const card = (o.card ?? {}) as Record<string, unknown>;
  const name = typeof card.name === 'string' ? card.name : null;
  const set = typeof card.setName === 'string' ? card.setName : null;
  const priceUsdCents =
    typeof card.priceUsdCents === 'number' ? card.priceUsdCents : null;
  const conf = typeof card.confidence === 'string' ? card.confidence : null;
  const cardId = typeof o.cardId === 'string' ? o.cardId : null;
  return trimExcerpt(
    `Card overview${name ? ` for ${name}` : ''}${set ? ` from ${set}` : ''}${cardId ? ` (id ${cardId})` : ''}. Blended FMV ${priceUsdCents !== null ? `$${(priceUsdCents / 100).toFixed(2)}` : 'unknown'}${conf ? ` at ${conf} confidence` : ''}.`
  );
};

interface TradeRow {
  priceUsdCents?: number | null;
  occurredAt?: string;
  source?: string;
  tradeId?: string;
}

const tradesExcerpt = (trades: TradeRow[]): string => {
  if (!Array.isArray(trades) || trades.length === 0) {
    return 'No recent trade comparables available.';
  }
  const parts = trades.slice(0, 3).map((t) => {
    const price =
      typeof t.priceUsdCents === 'number'
        ? `$${(t.priceUsdCents / 100).toFixed(2)}`
        : 'unknown';
    const when = typeof t.occurredAt === 'string' ? t.occurredAt : 'unknown date';
    const src = typeof t.source === 'string' ? t.source : '';
    return `${price} on ${when}${src ? ` (${src})` : ''}`;
  });
  return trimExcerpt(`Most recent ${parts.length} comparable trades: ${parts.join('; ')}.`);
};

/**
 * Summarize a raw per-trade series (Gap 7 — /v1/cards/by-id/{id}/series) into
 * a one-paragraph excerpt: count, min, max, avg, first/last observation.
 * Filters non-numeric points so a partial upstream doesn't blow up the mean.
 */
interface RawSeriesPoint {
  t?: string;
  usdCents?: number;
}
const seriesExcerpt = (points: RawSeriesPoint[], windowLabel: string): string => {
  if (!Array.isArray(points) || points.length === 0) {
    return `No raw price series available for the ${windowLabel} window.`;
  }
  const priced = points.filter(
    (p): p is { t: string; usdCents: number } =>
      typeof p.usdCents === 'number' &&
      Number.isFinite(p.usdCents) &&
      p.usdCents >= 0 &&
      typeof p.t === 'string'
  );
  if (priced.length === 0) {
    return `Received ${points.length} series points for the ${windowLabel} window but none were priced.`;
  }
  const cents = priced.map((p) => p.usdCents);
  const min = Math.min(...cents);
  const max = Math.max(...cents);
  const avg = cents.reduce((s, c) => s + c, 0) / cents.length;
  const first = priced[0];
  const last = priced[priced.length - 1];
  const usd = (c: number): string => `$${(c / 100).toFixed(2)}`;
  return trimExcerpt(
    `Raw trade series over the ${windowLabel} window: ${priced.length} points, min ${usd(min)}, max ${usd(max)}, avg ${usd(Math.round(avg))}. First point ${first.t} at ${usd(first.usdCents)}, most recent ${last.t} at ${usd(last.usdCents)}.`
  );
};

/**
 * Internal builder: convert a raw payload + URL + name into a Source object
 * with a clean 1-based citation id (assigned by `assignIds` later).
 */
type DraftSource = Omit<Source, 'id'>;

const draftFromCorpus = (seed: { title: string; url: string; excerpt: string }): DraftSource => ({
  name: seed.title,
  url: seed.url,
  excerpt: trimExcerpt(seed.excerpt),
  fetchedAt: nowIso(),
});

const assignIds = (drafts: DraftSource[]): Source[] => {
  return drafts.map((d, i) => ({ id: i + 1, ...d }));
};

/**
 * Padding: when live sources came back short, pad with the top corpus seeds
 * scored against the search text. Every corpus seed is a real, publicly
 * reachable URL (see corpus-seeds.ts). If the query is generic enough that
 * scoreCorpus returns no hits, we widen with a stable default query so the
 * retriever always has real seeds available.
 */
const CORPUS_FALLBACK_QUERY = 'renaiss api card cert grade fmv';

const padFromCorpus = (
  drafts: DraftSource[],
  scoreText: string,
  target = 2
): DraftSource[] => {
  if (drafts.length >= target) return drafts;
  const wanted = target - drafts.length;
  const primary = scoreCorpus(scoreText, wanted * 2);
  for (const s of primary) {
    if (drafts.length >= target) break;
    if (drafts.some((d) => d.url === s.url)) continue;
    drafts.push(draftFromCorpus(s));
  }
  if (drafts.length < target) {
    const fallback = scoreCorpus(CORPUS_FALLBACK_QUERY, target);
    for (const s of fallback) {
      if (drafts.length >= target) break;
      if (drafts.some((d) => d.url === s.url)) continue;
      drafts.push(draftFromCorpus(s));
    }
  }
  return drafts;
};

/**
 * Gather sources for a graded cert.
 *
 *   1. getOrFetchCert(cert) -> source 1 (cert summary)
 *   2. card overview via cardId from cert payload -> source 2
 *   3. recent trades via cardId -> source 3
 *   4. corpus seeds matched to cert string -> padding
 */
export const gatherSourcesForCert = async (cert: string): Promise<Source[]> => {
  const drafts: DraftSource[] = [];

  let cardId: string | null = null;
  try {
    const lookup = await getOrFetchCert(cert);
    if (lookup.found === true) {
      const confidence = (lookup.card?.confidence ?? null) as
        | 'high'
        | 'medium'
        | 'low'
        | null;
      drafts.push({
        name: `Renaiss Index API: cert ${cert}`,
        url: `https://api.renaissos.com/v1/graded/${encodeURIComponent(cert)}`,
        excerpt: certExcerpt(cert, lookup),
        confidence: confidence ?? undefined,
        fetchedAt: nowIso(),
      });
      cardId = extractCardIdFromCert(lookup);
    } else {
      console.warn(`${LOG_PREFIX} cert not found cert=${cert} reason=${lookup.reason ?? 'unknown'}`);
    }
  } catch (err) {
    if (err instanceof IndexApiError) {
      console.warn(`${LOG_PREFIX} cert lookup failed cert=${cert} status=${err.status}`);
    } else {
      console.error(`${LOG_PREFIX} cert lookup unexpected cert=${cert}:`, err);
    }
  }

  if (cardId !== null) {
    try {
      const overview = await renaissIndex.getCardOverview(cardId);
      drafts.push({
        name: `Renaiss Index API: card overview ${cardId}`,
        url: `https://api.renaissos.com/v1/cards/by-id/${encodeURIComponent(cardId)}/overview`,
        excerpt: overviewExcerpt(overview),
        fetchedAt: nowIso(),
      });
    } catch (err) {
      console.warn(`${LOG_PREFIX} overview failed cardId=${cardId}:`, err);
    }

    try {
      const trades = await renaissIndex.getCardTrades(cardId, { limit: 3 });
      drafts.push({
        name: `Renaiss Index API: recent trades for ${cardId}`,
        url: `https://api.renaissos.com/v1/cards/by-id/${encodeURIComponent(cardId)}/trades`,
        excerpt: tradesExcerpt(trades as TradeRow[]),
        fetchedAt: nowIso(),
      });
    } catch (err) {
      console.warn(`${LOG_PREFIX} trades failed cardId=${cardId}:`, err);
    }

    // Gap 7 enrichment: raw per-trade series for the last 7 days. Optional;
    // a failure here must NOT block the /explain response.
    try {
      const seriesResp = await renaissIndex.getCardSeries(cardId, {
        window: '7d',
      });
      const points = Array.isArray(
        (seriesResp as { points?: unknown }).points
      )
        ? ((seriesResp as { points: RawSeriesPoint[] }).points)
        : [];
      if (points.length > 0) {
        drafts.push({
          name: `Renaiss Index API: raw price series for ${cardId} (7d)`,
          url: `https://api.renaissos.com/v1/cards/by-id/${encodeURIComponent(cardId)}/series?window=7d`,
          excerpt: seriesExcerpt(points, '7-day'),
          fetchedAt: nowIso(),
        });
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} raw series failed cardId=${cardId}:`, err);
    }
  }

  padFromCorpus(drafts, cert, 2);
  const sources = assignIds(drafts);
  console.log(
    `${LOG_PREFIX} gatherSourcesForCert cert=${cert} sources=${sources.length}`
  );
  return sources;
};

/**
 * Gather sources for a Renaiss tokenId.
 *
 *   1. main API getCard(tokenId, verbosePrice=true, includeActivities)
 *      -> source 1 (card summary)
 *   2. If serial extracted, getOrFetchCert(serial) -> source 2
 *   3. If cardId extracted from cert payload, overview + trades -> sources 3,4
 *   4. corpus padding from card name/set if drafts < 2
 */
export const gatherSourcesForTokenId = async (tokenId: string): Promise<Source[]> => {
  const drafts: DraftSource[] = [];
  let scoreText = tokenId;

  let card: unknown = null;
  try {
    card = await renaissApi.getCard(tokenId, {
      verbosePrice: true,
      includeActivities: true,
      activitiesLimit: 3,
    });
    const cardObj = (card ?? {}) as Record<string, unknown>;
    const name = typeof cardObj.name === 'string' ? cardObj.name : null;
    const set = typeof cardObj.setName === 'string' ? cardObj.setName : null;
    const fmv = (cardObj as { fmvPriceInUSD?: unknown }).fmvPriceInUSD;
    const fmvStr =
      typeof fmv === 'string' || typeof fmv === 'number' ? String(fmv) : 'unknown';
    drafts.push({
      name: `Renaiss main API: card ${tokenId}`,
      url: `https://api.renaiss.xyz/v0/cards/${encodeURIComponent(tokenId)}`,
      excerpt: trimExcerpt(
        `Renaiss tokenId ${tokenId}${name ? ` is ${name}` : ''}${set ? ` from ${set}` : ''}. Reported fmvPriceInUSD (cents): ${fmvStr}.`
      ),
      fetchedAt: nowIso(),
    });
    scoreText = `${tokenId} ${name ?? ''} ${set ?? ''}`.trim();
  } catch (err) {
    if (err instanceof RenaissApiError) {
      console.warn(`${LOG_PREFIX} main API getCard failed tokenId=${tokenId} status=${err.status}`);
    } else {
      console.error(`${LOG_PREFIX} main API getCard unexpected tokenId=${tokenId}:`, err);
    }
  }

  const serial = extractSerial(card);
  let cardId: string | null = null;
  if (serial !== null) {
    const certUpper = serial.toUpperCase();
    try {
      const lookup = await getOrFetchCert(certUpper);
      if (lookup.found === true) {
        const confidence = (lookup.card?.confidence ?? null) as
          | 'high'
          | 'medium'
          | 'low'
          | null;
        drafts.push({
          name: `Renaiss Index API: cert ${certUpper}`,
          url: `https://api.renaissos.com/v1/graded/${encodeURIComponent(certUpper)}`,
          excerpt: certExcerpt(certUpper, lookup),
          confidence: confidence ?? undefined,
          fetchedAt: nowIso(),
        });
        cardId = extractCardIdFromCert(lookup);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} cert lookup failed tokenId=${tokenId} serial=${certUpper}:`, err);
    }
  }

  if (cardId !== null) {
    try {
      const trades = await renaissIndex.getCardTrades(cardId, { limit: 3 });
      drafts.push({
        name: `Renaiss Index API: recent trades for ${cardId}`,
        url: `https://api.renaissos.com/v1/cards/by-id/${encodeURIComponent(cardId)}/trades`,
        excerpt: tradesExcerpt(trades as TradeRow[]),
        fetchedAt: nowIso(),
      });
    } catch (err) {
      console.warn(`${LOG_PREFIX} trades failed cardId=${cardId}:`, err);
    }

    // Gap 7 enrichment: raw per-trade series for the last 7 days (upstream
    // enum coerces 7d -> 30 but the client normalizes for us). Optional; a
    // failure here must NOT block the /explain response, so we swallow and
    // move on. When present it gives the LLM min/max/avg/count grounding.
    try {
      const seriesResp = await renaissIndex.getCardSeries(cardId, {
        window: '7d',
      });
      const points = Array.isArray(
        (seriesResp as { points?: unknown }).points
      )
        ? ((seriesResp as { points: RawSeriesPoint[] }).points)
        : [];
      if (points.length > 0) {
        drafts.push({
          name: `Renaiss Index API: raw price series for ${cardId} (7d)`,
          url: `https://api.renaissos.com/v1/cards/by-id/${encodeURIComponent(cardId)}/series?window=7d`,
          excerpt: seriesExcerpt(points, '7-day'),
          fetchedAt: nowIso(),
        });
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} raw series failed cardId=${cardId}:`, err);
    }
  }

  padFromCorpus(drafts, scoreText, 2);
  const sources = assignIds(drafts);
  console.log(
    `${LOG_PREFIX} gatherSourcesForTokenId tokenId=${tokenId} sources=${sources.length}`
  );
  return sources;
};

/**
 * Pretty formatters for the CLI's non-JSON output.
 *
 * We deliberately avoid heavy TTY libraries (chalk, ora, cli-table3). A single
 * ANSI helper keeps the compiled Bun binary lean and dependency-free.
 *
 * Every pretty output ends with the BETA_DISCLOSURE_LINE so a human reader
 * always sees the safety marker.
 */

import { BETA_DISCLOSURE_LINE } from './envelope.ts';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

const supportsColor = (): boolean => {
  // Respect NO_COLOR; disable when not a TTY (piped to a file / another proc).
  if (process.env.NO_COLOR) return false;
  if (!process.stdout.isTTY) return false;
  return true;
};

const c = (color: keyof typeof ANSI, s: string): string => {
  if (!supportsColor()) return s;
  return `${ANSI[color]}${s}${ANSI.reset}`;
};

const line = (): string => c('gray', '─'.repeat(76));

const centsToUsd = (cents: number | null | undefined): string => {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return '—';
  return `$${(cents / 100).toFixed(2)}`;
};

const pct = (v: number | null | undefined): string => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
};

const truncate = (s: string, n: number): string => {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
};

export function withDisclosure(text: string): string {
  return `${text}\n\n${c('dim', BETA_DISCLOSURE_LINE)}`;
}

// ---------------------------------------------------------------------------
// GradedLookup (cert valuation)
// ---------------------------------------------------------------------------

export interface GradedLike {
  cert?: string;
  found?: boolean;
  reason?: string | null;
  gradeLabel?: string;
  card?: {
    name?: string;
    setName?: string;
    priceUsdCents?: number;
    deltaPct?: number;
    confidence?: string;
    lastSaleAt?: string;
    href?: string;
  } | null;
}

export function formatGraded(g: GradedLike): string {
  const rows: string[] = [];
  rows.push(c('bold', `Renaiss OS Index — Graded Cert Lookup`));
  rows.push(line());
  rows.push(`Cert:        ${g.cert ?? '—'}`);
  rows.push(`Found:       ${g.found ? c('green', 'yes') : c('yellow', 'no')}`);
  if (!g.found) {
    rows.push(`Reason:      ${g.reason ?? 'unknown'}`);
    return withDisclosure(rows.join('\n'));
  }
  const card = g.card ?? {};
  rows.push(`Card:        ${card.name ?? '—'}`);
  rows.push(`Set:         ${card.setName ?? '—'}`);
  rows.push(`Grade:       ${g.gradeLabel ?? '—'}`);
  rows.push(`FMV (USD):   ${c('cyan', centsToUsd(card.priceUsdCents))}`);
  const delta = card.deltaPct;
  const deltaColor: keyof typeof ANSI =
    typeof delta === 'number' && delta < 0 ? 'red' : 'green';
  rows.push(`Δ (7d):      ${c(deltaColor, pct(delta))}`);
  rows.push(`Confidence:  ${card.confidence ?? '—'}`);
  rows.push(`Last sale:   ${card.lastSaleAt ?? '—'}`);
  if (card.href) rows.push(`Ref:         ${c('dim', card.href)}`);
  return withDisclosure(rows.join('\n'));
}

// ---------------------------------------------------------------------------
// Market indices
// ---------------------------------------------------------------------------

export interface TileLike {
  game?: string;
  value?: number;
  base?: number;
  deltas?: { d7?: number; d30?: number; d365?: number };
  constituentCount?: number;
}

export function formatMarket(tiles: TileLike[], gameFilter?: string): string {
  const rows: string[] = [];
  rows.push(c('bold', `Renaiss OS Index — Market Tiles`));
  rows.push(line());
  const filtered = gameFilter
    ? tiles.filter((t) => t.game === gameFilter)
    : tiles;
  if (filtered.length === 0) {
    rows.push(c('yellow', 'No index tiles matched.'));
    return withDisclosure(rows.join('\n'));
  }
  rows.push(
    c('gray', 'game            value      d7        d30       d365      #cards')
  );
  for (const t of filtered) {
    const g = truncate(t.game ?? '—', 15).padEnd(16);
    const v = (typeof t.value === 'number' ? t.value.toFixed(2) : '—').padStart(9);
    const d7 = pct(t.deltas?.d7).padStart(9);
    const d30 = pct(t.deltas?.d30).padStart(9);
    const d365 = pct(t.deltas?.d365).padStart(9);
    const cc = String(t.constituentCount ?? '—').padStart(6);
    rows.push(`${g}${v}  ${d7} ${d30} ${d365} ${cc}`);
  }
  return withDisclosure(rows.join('\n'));
}

// ---------------------------------------------------------------------------
// Featured (top movers)
// ---------------------------------------------------------------------------

export interface FeaturedLike {
  name?: string;
  setName?: string;
  gradeLabel?: string;
  priceUsdCents?: number;
  deltaPct?: number;
  confidence?: string;
}

export function formatFeatured(cards: FeaturedLike[]): string {
  const rows: string[] = [];
  rows.push(c('bold', `Renaiss OS Index — Featured Movers`));
  rows.push(line());
  if (cards.length === 0) {
    rows.push(c('yellow', 'No featured cards.'));
    return withDisclosure(rows.join('\n'));
  }
  rows.push(c('gray', 'name                              grade         fmv         Δ 7d'));
  for (const card of cards) {
    const n = truncate(card.name ?? '—', 32).padEnd(33);
    const grade = truncate(card.gradeLabel ?? '—', 12).padEnd(13);
    const price = centsToUsd(card.priceUsdCents).padStart(10);
    const delta = pct(card.deltaPct).padStart(9);
    rows.push(`${n}${grade} ${price}  ${delta}`);
  }
  return withDisclosure(rows.join('\n'));
}

// ---------------------------------------------------------------------------
// Pulls
// ---------------------------------------------------------------------------

export interface PullLike {
  id?: string;
  collectibleTokenId?: string;
  name?: string;
  tier?: string | null;
  fmvCents?: number | null;
  pulledAtTimestamp?: string | number;
}

export function formatPulls(address: string, pulls: PullLike[]): string {
  const rows: string[] = [];
  rows.push(c('bold', `Recent pulls for ${address}`));
  rows.push(line());
  if (pulls.length === 0) {
    rows.push(c('yellow', 'No pulls found.'));
    return withDisclosure(rows.join('\n'));
  }
  rows.push(c('gray', 'when                          tier      fmv        name'));
  for (const p of pulls) {
    let when = '—';
    if (typeof p.pulledAtTimestamp === 'string') when = p.pulledAtTimestamp;
    else if (typeof p.pulledAtTimestamp === 'number') {
      const ms =
        p.pulledAtTimestamp < 1e12
          ? p.pulledAtTimestamp * 1000
          : p.pulledAtTimestamp;
      when = new Date(ms).toISOString();
    }
    const tier = truncate(p.tier ?? '—', 8).padEnd(9);
    const fmv = centsToUsd(p.fmvCents ?? null).padStart(9);
    const name = truncate(p.name ?? p.collectibleTokenId ?? '—', 32);
    rows.push(`${when.padEnd(30)}${tier} ${fmv}  ${name}`);
  }
  return withDisclosure(rows.join('\n'));
}

// ---------------------------------------------------------------------------
// Price (blended)
// ---------------------------------------------------------------------------

export interface PriceLike {
  input?: string;
  indexFmvUsd?: number | null;
  renaissFmvUsd?: number | null;
  confidence?: string | null;
  variancePct?: number | null;
  reason?: string | null;
}

// ---------------------------------------------------------------------------
// Marketplace (mirror of `renaiss marketplace`)
// ---------------------------------------------------------------------------

export interface MarketplaceRowLike {
  tokenId?: string;
  name?: string;
  setName?: string;
  grade?: string;
  gradingCompany?: string;
  /** USD cents encoded as a decimal string (upstream contract). */
  fmvPriceInUSD?: string;
  /** Base-1e18 uint256 encoded as a decimal string (upstream contract). */
  askPriceInUSDT?: string;
  year?: number;
}

export interface MarketplacePaginationLike {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Convert the "USD cents as string" upstream field to a `$xx.xx` display.
 * `fmvPriceInUSD` is documented as USD cents.
 */
const fmvCentsStringToUsd = (s: string | undefined): string => {
  if (!s || s.length === 0) return '—';
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  return `$${(n / 100).toFixed(2)}`;
};

/**
 * Convert an 18-decimal base-unit string to a `$xx.xx` display.
 * `askPriceInUSDT` is documented as base-1e18 wei.
 * Uses BigInt to avoid Number precision loss on large uint256 strings.
 */
const askWeiStringToUsd = (s: string | undefined): string => {
  if (!s || s.length === 0) return '—';
  if (!/^\d+$/.test(s)) return '—';
  try {
    const n = BigInt(s);
    const ONE = 10n ** 18n;
    const whole = n / ONE;
    const frac = ((n % ONE) * 100n) / ONE;
    return `$${whole.toString()}.${frac.toString().padStart(2, '0')}`;
  } catch {
    return '—';
  }
};

export function formatMarketplace(
  rows: MarketplaceRowLike[],
  pagination: MarketplacePaginationLike
): string {
  const out: string[] = [];
  out.push(c('bold', `Marketplace — Renaiss main API`));
  out.push(line());
  if (rows.length === 0) {
    out.push(c('yellow', 'No results matched the filters.'));
    return withDisclosure(out.join('\n'));
  }
  out.push(
    c(
      'gray',
      'tokenId          name                                     grade       grader   FMV        Ask'
    )
  );
  for (const r of rows) {
    const tid = truncate(r.tokenId ?? '—', 15).padEnd(17);
    const nm = truncate(r.name ?? '—', 40).padEnd(41);
    const gr = truncate(r.grade ?? '—', 10).padEnd(11);
    const gc = truncate(r.gradingCompany ?? '—', 7).padEnd(8);
    const fmv = fmvCentsStringToUsd(r.fmvPriceInUSD).padStart(9);
    const ask = askWeiStringToUsd(r.askPriceInUSDT).padStart(9);
    out.push(`${tid}${nm}${gr} ${gc} ${fmv}  ${ask}`);
  }
  const start = pagination.offset + 1;
  const end = pagination.offset + rows.length;
  out.push(
    c(
      'dim',
      `Showing ${start}-${end} of ${pagination.total}${pagination.hasMore ? ' — use --offset for next page' : ''}`
    )
  );
  return withDisclosure(out.join('\n'));
}

// ---------------------------------------------------------------------------
// Card (mirror of `renaiss card`)
// ---------------------------------------------------------------------------

export interface CardBlendLike {
  tokenId: string;
  cardName?: string | null;
  setName?: string | null;
  cardNumber?: string | null;
  gradingCompany?: string | null;
  grade?: string | null;
  serial?: string | null;
  imageUrl?: string | null;
  price?: {
    mainApiFmvUsdCents?: number | null;
    indexApiFmvUsdCents?: number | null;
    recommendedFmvUsdCents?: number | null;
    confidence?: string | null;
    lastSaleAt?: string | null;
    variancePctOver20?: boolean;
    onChainLastSale?: {
      priceUsdcFormatted?: string | null;
      paymentToken?: string | null;
      txHash?: string | null;
      blockNumber?: number | null;
      timestamp?: number | null;
      bscscanUrl?: string | null;
    } | null;
    sourceUrls?: {
      renaissMainCard?: string | null;
      renaissIndexCert?: string | null;
      bscscan?: string | null;
    };
  } | null;
  activities?: {
    items: unknown[];
    _reason?: string;
  } | null;
}

const shortHash = (h: string | null | undefined): string => {
  if (!h || h.length < 10) return h ?? '—';
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
};

const centsToUsdOrDash = (n: number | null | undefined): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `$${(n / 100).toFixed(2)}`;
};

export function formatCard(card: CardBlendLike): string {
  const out: string[] = [];
  out.push(c('bold', `Card: ${card.cardName ?? '—'}`));
  const setBits: string[] = [];
  if (card.setName) setBits.push(card.setName);
  if (card.cardNumber) setBits.push(`#${card.cardNumber}`);
  if (setBits.length > 0) out.push(`Set: ${setBits.join(', ')}`);
  if (card.gradingCompany || card.grade) {
    out.push(`Grade: ${card.gradingCompany ?? '—'} ${card.grade ?? ''}`.trim());
  }
  out.push(`tokenId: ${c('dim', card.tokenId)}`);

  if (card.price) {
    out.push('');
    out.push(c('bold', 'Prices:'));
    const mainCents = card.price.mainApiFmvUsdCents;
    const indexCents = card.price.indexApiFmvUsdCents;
    const rec = card.price.recommendedFmvUsdCents;
    const conf = card.price.confidence ?? '—';
    out.push(
      `  Renaiss main FMV:    ${c('magenta', centsToUsdOrDash(mainCents).padStart(9))}  (Renaiss main API)`
    );
    out.push(
      `  Renaiss OS Index:    ${c('cyan', centsToUsdOrDash(indexCents).padStart(9))}  (Index API, confidence: ${conf})`
    );
    const onchain = card.price.onChainLastSale;
    if (onchain && onchain.priceUsdcFormatted) {
      const tx = shortHash(onchain.txHash);
      out.push(
        `  On-chain last sale:  ${c('green', `$${onchain.priceUsdcFormatted}`.padStart(9))}  (Orderbook TradeExecutedV2, tx: ${tx})`
      );
    }
    if (typeof rec === 'number') {
      out.push(
        `  Recommended FMV:     ${c('bold', centsToUsdOrDash(rec).padStart(9))}`
      );
    }
    if (card.price.variancePctOver20) {
      out.push(
        c('yellow', '  Warning: main vs index diverge by more than 20%.')
      );
    }
    if (card.price.lastSaleAt) {
      out.push(`  Last sale timestamp: ${card.price.lastSaleAt}`);
    }
    if (card.price.sourceUrls) {
      const u = card.price.sourceUrls;
      out.push('');
      out.push(c('dim', 'Sources:'));
      if (u.renaissMainCard) out.push(c('dim', `  ${u.renaissMainCard}`));
      if (u.renaissIndexCert) out.push(c('dim', `  ${u.renaissIndexCert}`));
      if (u.bscscan) out.push(c('dim', `  ${u.bscscan}`));
    }
  }

  if (card.activities) {
    out.push('');
    out.push(c('bold', 'Activities:'));
    if (card.activities.items.length === 0) {
      out.push(
        c(
          'dim',
          `  (none available — ${card.activities._reason ?? 'no data'})`
        )
      );
    } else {
      for (const it of card.activities.items) {
        out.push(`  ${JSON.stringify(it)}`);
      }
    }
  }

  return withDisclosure(out.join('\n'));
}

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

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

const parsePackUsdtWei = (raw: string | undefined): string => {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return '-';
  try {
    const wei = BigInt(raw);
    const usdt = Number(wei / 10n ** 18n);
    if (!Number.isFinite(usdt)) return '-';
    return `${usdt.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT`;
  } catch {
    return '-';
  }
};

const parsePackUsdString = (raw: string | undefined): string => {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return '-';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '-';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
};

export function formatPacks(packs: PackLike[], mode: 'list' | 'detail'): string {
  const rows: string[] = [];
  if (mode === 'detail') {
    rows.push(c('bold', 'Renaiss Pack Detail'));
    rows.push(line());
    const p = packs[0];
    if (!p) {
      rows.push(c('yellow', 'Pack not found.'));
      return withDisclosure(rows.join('\n'));
    }
    rows.push(`Slug:              ${p.slug ?? '-'}`);
    rows.push(`Name:              ${p.name ?? '-'}`);
    rows.push(`Type:              ${p.packType ?? '-'}`);
    rows.push(`Stage:             ${p.stage ?? '-'}`);
    rows.push(`Author:            ${p.author ?? '-'}`);
    rows.push(`Price:             ${c('cyan', parsePackUsdtWei(p.priceInUsdt))}`);
    rows.push(`Expected value:    ${c('magenta', parsePackUsdString(p.expectedValueInUsd))}`);
    rows.push(`Featured card FMV: ${parsePackUsdString(p.featuredCardFmvInUsd)}`);
    if (typeof p.description === 'string' && p.description.length > 0) {
      const firstLines = p.description.split('\n').slice(0, 4).join('\n');
      rows.push('');
      rows.push(c('dim', firstLines));
    }
    return withDisclosure(rows.join('\n'));
  }

  rows.push(c('bold', 'Renaiss Packs'));
  rows.push(line());
  if (packs.length === 0) {
    rows.push(c('yellow', 'No packs.'));
    return withDisclosure(rows.join('\n'));
  }
  rows.push(
    c(
      'gray',
      'slug                       type        stage                    price          EV'
    )
  );
  for (const p of packs) {
    const slug = truncate(p.slug ?? '-', 26).padEnd(27);
    const type = truncate(p.packType ?? '-', 10).padEnd(11);
    const stage = truncate(p.stage ?? '-', 24).padEnd(25);
    const price = parsePackUsdtWei(p.priceInUsdt).padStart(14);
    const ev = parsePackUsdString(p.expectedValueInUsd).padStart(10);
    rows.push(`${slug}${type} ${stage}${price}  ${ev}`);
  }
  return withDisclosure(rows.join('\n'));
}

// ---------------------------------------------------------------------------
// Pack info (gacha info) — pack detail + dual-window odds blend
// ---------------------------------------------------------------------------

export interface PackInfoBlendLike {
  pack: PackLike;
  odds: {
    upstream_recent: {
      sampleSize: number;
      tierFrequency: Array<{ tier: string; count: number; pct: number }>;
      error: string | null;
    };
    empirical_90d: {
      windowDays: number;
      totalPulls: number;
      insufficientSample: boolean;
      minSample: number;
      tierFrequency: Array<{ tier: string; count: number; pct: number }>;
      error: string | null;
    };
    divergence: Array<{
      tier: string;
      deltaPct: number;
      flagged: boolean;
    }>;
  };
}

const fmtTierRow = (
  tier: string,
  pct01: number,
  count: number,
  countLabel: string
): string => {
  const paddedTier = tier.padEnd(10);
  const percent = (pct01 * 100).toFixed(0).padStart(3) + '%';
  const countStr = countLabel === 'n' ? `(n=${count})` : `(${count} ${countLabel})`;
  return `  ${paddedTier} ${percent}   ${countStr}`;
};

export function formatPackInfo(blend: PackInfoBlendLike): string {
  const rows: string[] = [];
  const p = blend.pack;

  rows.push(c('bold', `Pack: ${p.name ?? '(unknown)'} (${p.slug ?? '-'})`));
  rows.push(line());
  rows.push(`Type: ${p.packType ?? '-'} · Stage: ${p.stage ?? '-'}`);
  if (p.author) rows.push(`Author: ${p.author}`);
  rows.push(`Price: ${c('cyan', parsePackUsdtWei(p.priceInUsdt))}`);
  rows.push(
    `Expected Value: ${c('magenta', parsePackUsdString(p.expectedValueInUsd))}`
  );
  rows.push(`Featured FMV: ${parsePackUsdString(p.featuredCardFmvInUsd)}`);
  rows.push('');

  // Upstream recent block.
  const up = blend.odds.upstream_recent;
  if (up.error) {
    rows.push(c('yellow', `Recent tier frequency: ${up.error}`));
  } else if (up.sampleSize === 0) {
    rows.push(c('dim', 'Recent tier frequency: no data available'));
  } else {
    rows.push(
      `Recent tier frequency (last ~${up.sampleSize} pulls, upstream feed):`
    );
    for (const row of up.tierFrequency) {
      rows.push(fmtTierRow(row.tier, row.pct, row.count, 'pulls'));
    }
  }
  rows.push('');

  // Empirical 90d block.
  const emp = blend.odds.empirical_90d;
  if (emp.error) {
    rows.push(c('yellow', `Empirical odds: ${emp.error}`));
  } else if (emp.insufficientSample) {
    rows.push(
      c(
        'dim',
        `Empirical odds (trailing ${emp.windowDays}d, PullCast indexer): n=${emp.totalPulls}, min sample=${emp.minSample}`
      )
    );
  } else {
    rows.push(
      `Empirical odds (trailing ${emp.windowDays}d, PullCast indexer):`
    );
    for (const row of emp.tierFrequency) {
      rows.push(fmtTierRow(row.tier, row.pct, row.count, 'n'));
    }
  }
  rows.push('');

  // Divergence.
  const flagged = blend.odds.divergence.filter((d) => d.flagged);
  if (flagged.length === 0) {
    rows.push('Divergence (>20% delta between windows): none');
  } else {
    rows.push('Divergence (>20% delta between windows):');
    for (const d of flagged) {
      const sign = d.deltaPct > 0 ? '+' : '';
      rows.push(
        `  ${d.tier.padEnd(10)} ${c('yellow', `${sign}${d.deltaPct.toFixed(1)}pp`)}`
      );
    }
  }

  return withDisclosure(rows.join('\n'));
}

export function formatPrice(p: PriceLike): string {
  const rows: string[] = [];
  rows.push(c('bold', `PullCast Price Blend`));
  rows.push(line());
  rows.push(`Input:               ${p.input ?? '—'}`);
  const indexFmv =
    typeof p.indexFmvUsd === 'number'
      ? c('cyan', `$${p.indexFmvUsd.toFixed(2)}`)
      : '—';
  const renaissFmv =
    typeof p.renaissFmvUsd === 'number'
      ? c('magenta', `$${p.renaissFmvUsd.toFixed(2)}`)
      : '—';
  rows.push(`Renaiss OS Index:    ${indexFmv}`);
  rows.push(`Renaiss main FMV:    ${renaissFmv}`);
  rows.push(`Confidence:          ${p.confidence ?? '—'}`);
  if (typeof p.variancePct === 'number') {
    rows.push(`Variance:            ${pct(p.variancePct)}`);
  }
  if (p.reason) rows.push(`Note:                ${p.reason}`);
  return withDisclosure(rows.join('\n'));
}

// ---------------------------------------------------------------------------
// Recent trades (Index API)
// ---------------------------------------------------------------------------

interface TradeLike {
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

export function formatTrades(trades: TradeLike[]): string {
  const rows: string[] = [];
  rows.push(c('bold', 'Renaiss OS Index — Recent Trades'));
  rows.push(line());
  if (trades.length === 0) {
    rows.push(c('dim', 'No trades returned.'));
    return withDisclosure(rows.join('\n'));
  }
  for (const t of trades) {
    const name = t.card?.name ?? 'Unknown';
    const grade = t.gradeLabel ?? '—';
    const price = centsToUsd(t.priceUsdCents ?? null);
    const when = t.observedAt ? t.observedAt.slice(0, 16).replace('T', ' ') : '—';
    const src = t.displayName ?? 'Index';
    rows.push(
      `${truncate(name, 36).padEnd(38)} ${grade.padEnd(12)} ${price.padStart(10)}  ${c('dim', src)}`
    );
    rows.push(`  ${c('dim', when)}`);
  }
  return withDisclosure(rows.join('\n'));
}

// ---------------------------------------------------------------------------
// Index search results
// ---------------------------------------------------------------------------

interface SearchLike {
  name?: string;
  setName?: string;
  cardNumber?: string;
  gradeLabel?: string;
  priceUsdCents?: number | null;
  confidence?: string;
  href?: string;
}

export function formatSearch(query: string, results: SearchLike[]): string {
  const rows: string[] = [];
  rows.push(c('bold', `Renaiss OS Index — Search: "${query}"`));
  rows.push(line());
  if (results.length === 0) {
    rows.push(c('dim', 'No results returned.'));
    return withDisclosure(rows.join('\n'));
  }
  for (const r of results) {
    const name = r.name ?? 'Unknown';
    const meta = [
      r.gradeLabel ?? null,
      r.setName ? truncate(r.setName, 24) : null,
      r.cardNumber ? `#${r.cardNumber}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const price = centsToUsd(r.priceUsdCents ?? null);
    const conf = r.confidence ? c('dim', ` (${r.confidence})`) : '';
    rows.push(`${truncate(name, 40).padEnd(42)} ${price.padStart(10)}${conf}`);
    if (meta) rows.push(`  ${c('dim', meta)}`);
  }
  return withDisclosure(rows.join('\n'));
}

// ---------------------------------------------------------------------------
// Index set listing
// ---------------------------------------------------------------------------

interface SetCardFmt {
  name?: string;
  gradeLabel?: string;
  priceUsdCents?: number | null;
}

export function formatSet(listing: {
  setName?: string | null;
  cardCount?: number;
  cards: SetCardFmt[];
}): string {
  const rows: string[] = [];
  const title = listing.setName ?? 'Set listing';
  rows.push(c('bold', `Renaiss OS Index — ${title}`));
  rows.push(
    c('dim', `${listing.cardCount ?? listing.cards.length} cards indexed`)
  );
  rows.push(line());
  const top = [...listing.cards]
    .sort((a, b) => (b.priceUsdCents ?? 0) - (a.priceUsdCents ?? 0))
    .slice(0, 8);
  if (top.length === 0) {
    rows.push(c('dim', 'No cards in this set.'));
    return withDisclosure(rows.join('\n'));
  }
  for (const card of top) {
    const name = card.name ?? 'Unknown';
    const grade = card.gradeLabel ?? '—';
    const price = centsToUsd(card.priceUsdCents ?? null);
    rows.push(`${truncate(name, 36).padEnd(38)} ${grade.padEnd(12)} ${price.padStart(10)}`);
  }
  return withDisclosure(rows.join('\n'));
}

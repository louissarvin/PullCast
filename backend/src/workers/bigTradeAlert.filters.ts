/**
 * Pure filter + embed helpers for the Big Trade Alert worker.
 *
 * Split out of `bigTradeAlert.ts` so tests can exercise the qualifying-trade
 * filter, the cursor advance, and the embed shape without spinning up cron,
 * Prisma, or Discord.
 *
 * No side effects. No DB access. No network. Deterministic given the inputs.
 */

import { EmbedBuilder } from 'discord.js';
import { discordEmbedFooter } from '../lib/disclosure/index.ts';
import { buildDisclosureField } from '../lib/discord/embed-builders.ts';
import type { IndexTrade } from '../lib/renaiss-index/index.ts';
import { sanitizeImageUrl, sanitizeShortText } from '../utils/urlAllowlist.ts';

/**
 * D8-M-5: hard length caps on card text fields before they flow into an
 * embed. Discord embeds cap `description` at 4096 chars and individual field
 * values at 1024 chars server-side; we clip much lower so the digest embed
 * with up to 10 lines cannot overflow, and so a compromised upstream cannot
 * inject Discord line-break characters (CR / LF / U+2028 / U+2029) that
 * shift the embed layout.
 */
const MAX_CARD_TEXT_LEN = 128;

/**
 * A trade that survived the (kind=transaction, priceUsdCents>=threshold,
 * observedAt after cursor) filter. `observedAtMs` is normalized to epoch ms so
 * downstream sort/compare is one type.
 */
export interface QualifyingTrade {
  trade: IndexTrade;
  priceUsdCents: number;
  observedAt: Date;
  observedAtMs: number;
}

/**
 * Parse the observedAt string on a trade. Returns null when the value is
 * missing or unparseable so the caller can drop the trade rather than emit an
 * embed with an invalid timestamp.
 */
export const parseObservedAt = (trade: IndexTrade): Date | null => {
  const raw = trade.observedAt ?? trade.occurredAt;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
};

export interface FilterInput {
  trades: IndexTrade[];
  thresholdCents: number;
  /** Only alert on trades newer than this cursor. null = no cursor yet. */
  cursorMs: number | null;
}

/**
 * Reduce a batch of trades to just the ones that qualify for an alert.
 * Sorted oldest-first so the caller's cursor advance is monotonic.
 *
 * Rules:
 *   - kind === 'transaction'      (skip listings)
 *   - priceUsdCents >= threshold  (skip below the alert bar)
 *   - observedAt is parseable
 *   - observedAt.getTime() > cursorMs (skip already-alerted trades)
 */
export const filterQualifyingTrades = (input: FilterInput): QualifyingTrade[] => {
  const out: QualifyingTrade[] = [];
  for (const trade of input.trades) {
    if (trade.kind !== 'transaction') continue;
    const price = trade.priceUsdCents;
    if (typeof price !== 'number' || !Number.isFinite(price)) continue;
    if (price < input.thresholdCents) continue;
    const observedAt = parseObservedAt(trade);
    if (observedAt === null) continue;
    const observedAtMs = observedAt.getTime();
    if (input.cursorMs !== null && observedAtMs <= input.cursorMs) continue;
    out.push({ trade, priceUsdCents: price, observedAt, observedAtMs });
  }
  out.sort((a, b) => a.observedAtMs - b.observedAtMs);
  return out;
};

/**
 * Return the newest observedAtMs across the qualifying set, or null if empty.
 * Callers use this to advance the persisted cursor after a successful tick.
 */
export const newestObservedAtMs = (qualifying: QualifyingTrade[]): number | null => {
  if (qualifying.length === 0) return null;
  let max = qualifying[0].observedAtMs;
  for (let i = 1; i < qualifying.length; i += 1) {
    if (qualifying[i].observedAtMs > max) max = qualifying[i].observedAtMs;
  }
  return max;
};

/**
 * Discord logo-safe label for the `source` field of a trade. The upstream
 * enum values from the OpenAPI are snkrdunk / public / partner / renaiss-internal.
 * Anything else falls back to the raw string, which the embed presents as-is.
 */
const SOURCE_LABELS: Record<string, string> = {
  snkrdunk: 'snkrdunk',
  public: 'Public marketplaces',
  partner: 'Partner shops',
  'renaiss-internal': 'Renaiss vault sales',
};

export const sourceLabel = (source: string | undefined | null): string => {
  if (typeof source !== 'string' || source.length === 0) return 'unknown';
  return SOURCE_LABELS[source] ?? source;
};

const formatUsd = (cents: number): string => {
  if (!Number.isFinite(cents)) return '–';
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) {
    return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  return `$${dollars.toFixed(2)}`;
};

const formatMinor = (
  minor: number | null | undefined,
  currency: string | undefined
): string | null => {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return null;
  if (typeof currency !== 'string' || currency.length === 0) return null;
  if (currency === 'USD') return null; // duplicate of USD line
  // JPY has no minor subunit; heuristic: treat as-is if not USD-cent style.
  // We display the currency code + integer; downstream Discord users can
  // recognize JPY notation.
  const value = minor.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (currency === 'JPY') return `¥${value}`;
  return `${value} ${currency}`;
};

export interface BuildAlertEmbedInput {
  qualifying: QualifyingTrade;
}

/**
 * Build the per-trade Big Trade Alert embed. Includes card thumbnail, price,
 * source, `View source` link, observedAt timestamp, currency note if non-USD,
 * disclosure field, and the mandatory beta footer.
 */
export const buildBigTradeAlertEmbed = (
  input: BuildAlertEmbedInput
): EmbedBuilder => {
  const { trade, priceUsdCents, observedAt } = input.qualifying;
  const card = trade.card;
  // D8-M-5: sanitize length + strip newlines on every card text field before
  // it enters the embed. `sanitizeShortText` returns null on empty / invalid
  // so the `?? 'Unknown card'` fallback kicks in exactly like before.
  const cardName = sanitizeShortText(card?.name, MAX_CARD_TEXT_LEN) ?? 'Unknown card';
  const setName = sanitizeShortText(card?.setName ?? card?.setCode, MAX_CARD_TEXT_LEN);
  const cardNumber = sanitizeShortText(card?.cardNumber, 32);
  const setLine = [setName, cardNumber ? `#${cardNumber}` : null]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ');
  const gradeLine =
    sanitizeShortText(card?.gradeLabel ?? card?.grade, MAX_CARD_TEXT_LEN) ?? '';
  const descriptionParts = [setLine, gradeLine].filter((v) => v.length > 0);

  const embed = new EmbedBuilder()
    .setTitle(`Big Trade Alert: ${cardName}`)
    .setColor(0xf1c40f)
    .setFooter(discordEmbedFooter());

  if (descriptionParts.length > 0) {
    embed.setDescription(descriptionParts.join('  ·  '));
  }

  embed.addFields(
    { name: 'Price', value: formatUsd(priceUsdCents), inline: true },
    { name: 'Source', value: sourceLabel(trade.source), inline: true },
    {
      name: 'Observed',
      value: `<t:${Math.floor(observedAt.getTime() / 1000)}:R>`,
      inline: true,
    }
  );

  const currencyLine = formatMinor(trade.priceMinor ?? null, trade.currency);
  if (currencyLine !== null) {
    embed.addFields({ name: 'Original', value: currencyLine, inline: true });
  }

  if (typeof trade.sourceUrl === 'string' && /^https?:\/\//.test(trade.sourceUrl)) {
    embed.addFields({
      name: 'View source',
      value: `[Open listing](${trade.sourceUrl})`,
      inline: false,
    });
  }

  embed.addFields(buildDisclosureField());

  // D8-M-5: SSRF-guard the thumbnail URL. discord.js validates URL syntax
  // but does NOT restrict host, so a compromised upstream returning
  // `http://attacker.com/tracker.png` would cause every Discord client that
  // renders the embed to fetch attacker-controlled content. Route through
  // the shared allowlist (see `src/utils/urlAllowlist.ts`) and silently skip
  // the thumbnail when the URL is not allowed.
  const safeThumbnail = sanitizeImageUrl(card?.imageUrl);
  if (safeThumbnail !== null) {
    try {
      embed.setThumbnail(safeThumbnail);
    } catch {
      // ignore invalid thumbnail; the rest of the embed still ships
    }
  } else if (
    typeof card?.imageUrl === 'string' &&
    card.imageUrl.length > 0
  ) {
    // Log once per drop for observability, but do not include the URL in the
    // log line to avoid persisting the attacker-controlled value.
    console.warn('[bigTradeAlert] blocked non-allowlisted imageUrl on thumbnail');
  }

  embed.setTimestamp(observedAt);
  return embed;
};

export interface BuildDigestEmbedInput {
  qualifying: QualifyingTrade[];
  totalCount: number;
}

/**
 * Build a single digest embed for the case where >N trades qualify in one tick.
 * Lists the top by price so a channel does not receive N individual alerts.
 */
export const buildBigTradeDigestEmbed = (
  input: BuildDigestEmbedInput
): EmbedBuilder => {
  // Show top 10 by price desc so the biggest moves come first.
  const top = [...input.qualifying]
    .sort((a, b) => b.priceUsdCents - a.priceUsdCents)
    .slice(0, 10);

  const lines = top.map((q) => {
    // D8-M-5: length-cap + newline-strip each per-trade text field so 10
    // long names cannot overflow the 4096-char embed `description` cap and
    // so an upstream that injects CR / LF / U+2028 cannot break the digest
    // layout.
    const name =
      sanitizeShortText(q.trade.card?.name, MAX_CARD_TEXT_LEN) ?? 'Unknown card';
    const grade =
      sanitizeShortText(
        q.trade.card?.gradeLabel ?? q.trade.card?.grade,
        MAX_CARD_TEXT_LEN
      ) ?? '';
    const src = sourceLabel(q.trade.source);
    const price = formatUsd(q.priceUsdCents);
    const gradeSuffix = grade ? ` (${grade})` : '';
    return `${price} — ${name}${gradeSuffix} · ${src}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`Big Trade Alert: ${input.totalCount} qualifying trades this window`)
    .setColor(0xe74c3c)
    .setDescription(
      [
        'Multiple large trades observed this poll window. Top by price:',
        '',
        lines.join('\n'),
      ].join('\n')
    )
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());

  return embed;
};

/**
 * Parse Subscription.metadata JSON safely. Returns the threshold override in
 * USD cents, or null if none set / invalid.
 */
export const parseChannelThresholdCents = (
  metadata: string | null | undefined
): number | null => {
  if (typeof metadata !== 'string' || metadata.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const raw = (parsed as Record<string, unknown>).threshold_usd_cents;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
    return Math.floor(raw);
  } catch {
    return null;
  }
};

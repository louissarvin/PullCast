import {
  APIEmbedField,
  EmbedBuilder,
  type ColorResolvable,
} from 'discord.js';
import {
  DISCLOSURE_TEXT_FULL,
  discordEmbedFooter,
} from '../disclosure/index.ts';

const LOG_PREFIX = '[discord]';

/**
 * Lean local types so this module does not depend on the Prisma generated
 * client (which only exists after `bun run db:push`). The real Pull row from
 * Prisma is structurally compatible.
 */
export interface PullEmbedInput {
  id: string;
  packSlug: string;
  cardName?: string | null;
  setName?: string | null;
  cardNumber?: string | null;
  gradingCompany?: string | null;
  grade?: string | null;
  tier?: string | null;
  fmvUsdCents?: number | null;
  packPriceUsdCents: number;
  netGainUsdCents?: number | null;
  frontImageUrl?: string | null;
  buyerAddress?: string | null;
  pulledAtTimestamp?: Date | string | null;
}

export interface PriceLookupResult {
  tokenIdOrCert: string;
  cardName?: string | null;
  setName?: string | null;
  grade?: string | null;
  mainApiFmvCents?: number | null;
  indexApiFmvCents?: number | null;
  recommendedFmvCents?: number | null;
  confidence?: 'prime' | 'high' | 'medium' | 'low' | null;
  lastSaleAt?: Date | string | null;
  imageUrl?: string | null;
  sources?: Array<{ name: string; url: string }>;
}

/**
 * Tier-to-color mapping. Defaults to "common gray" if the tier string does not
 * match a known bucket. Case insensitive.
 */
const TIER_COLORS: Record<string, ColorResolvable> = {
  legendary: 0xffd700, // gold
  mythic: 0xffd700,
  rare: 0x9b59b6, // purple
  epic: 0x9b59b6,
  uncommon: 0x3498db, // blue
  common: 0x95a5a6, // gray
};

const colorForTier = (tier: string | null | undefined): ColorResolvable => {
  if (typeof tier !== 'string' || tier.length === 0) {
    return TIER_COLORS.common;
  }
  return TIER_COLORS[tier.toLowerCase()] ?? TIER_COLORS.common;
};

const formatUsdFromCents = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) {
    return '–';
  }
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) {
    return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  return `$${dollars.toFixed(2)}`;
};

const formatSignedUsdFromCents = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) {
    return '–';
  }
  const sign = cents >= 0 ? '+' : '-';
  return `${sign}${formatUsdFromCents(Math.abs(cents))}`;
};

/**
 * Single-source disclosure injection. Embed builders that include data fields
 * call this to drop a final spacer-style disclosure field into the embed
 * body, in addition to the footer. Two surfaces for one mandate; defense in
 * depth.
 */
export const buildDisclosureField = (): APIEmbedField => {
  return {
    name: '​', // zero-width space; renders as visual divider in Discord
    value: DISCLOSURE_TEXT_FULL,
    inline: false,
  };
};

/**
 * Build a pull-share embed. Compact mode drops the image and trims fields
 * for inline previews (e.g. /pullcast list output).
 */
export const buildPullEmbed = (
  pull: PullEmbedInput,
  opts: { compact?: boolean } = {}
): EmbedBuilder => {
  const compact = opts.compact === true;
  const title = pull.cardName ?? pull.setName ?? `Pull ${pull.id}`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(colorForTier(pull.tier ?? null))
    .setFooter(discordEmbedFooter());

  const fields: APIEmbedField[] = [];
  const cardLine = [pull.setName, pull.cardNumber].filter((v): v is string => Boolean(v)).join(' #');
  if (cardLine.length > 0) {
    fields.push({ name: 'Card', value: cardLine, inline: true });
  }
  if (pull.gradingCompany || pull.grade) {
    const gradeText = [pull.gradingCompany, pull.grade].filter((v): v is string => Boolean(v)).join(' ');
    fields.push({ name: 'Grade', value: gradeText, inline: true });
  }
  fields.push({
    name: 'FMV',
    value: formatUsdFromCents(pull.fmvUsdCents ?? null),
    inline: true,
  });
  fields.push({
    name: 'Pack Cost',
    value: formatUsdFromCents(pull.packPriceUsdCents),
    inline: true,
  });
  fields.push({
    name: 'Net P&L',
    value: formatSignedUsdFromCents(pull.netGainUsdCents ?? null),
    inline: true,
  });
  if (pull.tier) {
    fields.push({ name: 'Tier', value: pull.tier, inline: true });
  }

  fields.push(buildDisclosureField());
  embed.addFields(fields);

  if (!compact && pull.frontImageUrl) {
    try {
      embed.setImage(pull.frontImageUrl);
    } catch (err) {
      console.warn(`${LOG_PREFIX} setImage rejected url=${pull.frontImageUrl} reason=${formatErr(err)}`);
    }
  }

  if (pull.pulledAtTimestamp) {
    const ts =
      pull.pulledAtTimestamp instanceof Date
        ? pull.pulledAtTimestamp
        : new Date(pull.pulledAtTimestamp);
    if (!Number.isNaN(ts.getTime())) {
      embed.setTimestamp(ts);
    }
  }

  return embed;
};

/**
 * Build the /price command embed. Side-by-side main + index FMV, with the
 * recommended blend pinned at the top.
 */
export const buildPriceEmbed = (payload: PriceLookupResult): EmbedBuilder => {
  const title = payload.cardName
    ? `${payload.cardName}${payload.grade ? ` (${payload.grade})` : ''}`
    : `Price: ${payload.tokenIdOrCert}`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x3498db)
    .setFooter(discordEmbedFooter());

  const fields: APIEmbedField[] = [
    {
      name: 'Recommended FMV',
      value: formatUsdFromCents(payload.recommendedFmvCents ?? null),
      inline: false,
    },
    {
      name: 'Main API',
      value: formatUsdFromCents(payload.mainApiFmvCents ?? null),
      inline: true,
    },
    {
      name: 'Index API',
      value: formatUsdFromCents(payload.indexApiFmvCents ?? null),
      inline: true,
    },
  ];

  if (payload.confidence) {
    fields.push({ name: 'Confidence', value: payload.confidence, inline: true });
  }
  if (payload.setName) {
    fields.push({ name: 'Set', value: payload.setName, inline: true });
  }
  if (payload.lastSaleAt) {
    const ts =
      payload.lastSaleAt instanceof Date ? payload.lastSaleAt : new Date(payload.lastSaleAt);
    if (!Number.isNaN(ts.getTime())) {
      fields.push({
        name: 'Last Sale',
        value: `<t:${Math.floor(ts.getTime() / 1000)}:R>`,
        inline: true,
      });
    }
  }

  fields.push(buildDisclosureField());
  embed.addFields(fields);

  if (payload.imageUrl) {
    try {
      embed.setThumbnail(payload.imageUrl);
    } catch (err) {
      console.warn(`${LOG_PREFIX} setThumbnail rejected reason=${formatErr(err)}`);
    }
  }

  return embed;
};

/**
 * Input shape for the /odds embed. The slash command + the REST route compute
 * the same stats; this is the shared display contract.
 *
 * D8: extended with `upstreamRecent` (Renaiss last-30 tier freq) and
 * `divergence` so the slash command mirrors the REST envelope side-by-side.
 * Both are optional so legacy callers stay green.
 */
export interface OddsTierFreqLine {
  tier: string;
  count: number;
  pct: number; // 0..1
}

export interface OddsDivergenceLine {
  tier: string;
  upstreamPct: number;
  empiricalPct: number;
  deltaPct: number; // percentage points, signed (upstream - empirical)
  flagged: boolean;
}

export interface OddsEmbedInput {
  packSlug: string;
  totalPulls: number;
  meanNetGainUsdCents: number;
  medianNetGainUsdCents: number;
  winRate: number; // 0..1
  top5: Array<{
    netGainUsdCents: number;
    grade?: string | null;
    gradingCompany?: string | null;
  }>;
  byTier: Record<string, { count: number; avgNetGain: number }>;
  windowDays: number;
  upstreamRecent?: {
    sampleSize: number;
    tierFrequency: OddsTierFreqLine[];
    error?: string | null;
  };
  divergence?: OddsDivergenceLine[];
}

const formatPct = (p: number): string => {
  if (!Number.isFinite(p)) return '–';
  const clamped = Math.max(0, Math.min(1, p));
  return `${(clamped * 100).toFixed(1)}%`;
};

/**
 * Build the /odds command embed. Pack stats over the configured window. The
 * caller MUST have already enforced a minimum-sample threshold (n >= 10)
 * before calling this; the embed assumes the input is meaningful.
 */
export const buildOddsEmbed = (input: OddsEmbedInput): EmbedBuilder => {
  const embed = new EmbedBuilder()
    .setTitle(`Pull odds: ${input.packSlug}`)
    .setColor(0x2ecc71)
    .setFooter(discordEmbedFooter());

  const description = `Sample: ${input.totalPulls} pulls over the last ${input.windowDays} days.\nWin rate (net > 0): ${formatPct(input.winRate)}.`;
  embed.setDescription(description);

  const fields: APIEmbedField[] = [
    {
      name: 'Mean Net P&L',
      value: formatSignedUsdFromCents(input.meanNetGainUsdCents),
      inline: true,
    },
    {
      name: 'Median Net P&L',
      value: formatSignedUsdFromCents(input.medianNetGainUsdCents),
      inline: true,
    },
    {
      name: 'Sample size',
      value: String(input.totalPulls),
      inline: true,
    },
  ];

  if (Array.isArray(input.top5) && input.top5.length > 0) {
    const lines = input.top5.slice(0, 5).map((p, idx) => {
      const gradeLabel = [p.gradingCompany, p.grade]
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .join(' ');
      const tail = gradeLabel.length > 0 ? ` (${gradeLabel})` : '';
      return `${idx + 1}. ${formatSignedUsdFromCents(p.netGainUsdCents)}${tail}`;
    });
    fields.push({
      name: `Top ${lines.length}`,
      value: lines.join('\n'),
      inline: false,
    });
  }

  const tierKeys = Object.keys(input.byTier);
  if (tierKeys.length > 0) {
    // Sort tiers by sample count desc so the headline tiers come first.
    tierKeys.sort((a, b) => input.byTier[b].count - input.byTier[a].count);
    const lines = tierKeys.map((t) => {
      const b = input.byTier[t];
      return `${t}: ${b.count} pulls, avg ${formatSignedUsdFromCents(b.avgNetGain)}`;
    });
    fields.push({
      name: 'Empirical 90d by tier (PullCast indexer)',
      value: lines.join('\n'),
      inline: true,
    });
  }

  // D8: Renaiss recent-30 tier frequency side-by-side.
  if (input.upstreamRecent) {
    if (input.upstreamRecent.error) {
      fields.push({
        name: 'Recent activity (Renaiss main API)',
        value: `Unavailable: ${input.upstreamRecent.error}`,
        inline: true,
      });
    } else if (input.upstreamRecent.tierFrequency.length > 0) {
      const lines = input.upstreamRecent.tierFrequency
        .slice(0, 8)
        .map(
          (t) =>
            `${t.tier}: ${t.count} (${(t.pct * 100).toFixed(1)}%)`
        );
      fields.push({
        name: `Recent activity (Renaiss last ~${input.upstreamRecent.sampleSize})`,
        value: lines.join('\n'),
        inline: true,
      });
    }
  }

  // D8: divergence callout beneath the two blocks.
  if (Array.isArray(input.divergence) && input.divergence.length > 0) {
    const flagged = input.divergence.filter((d) => d.flagged).slice(0, 5);
    if (flagged.length > 0) {
      const lines = flagged.map(
        (d) =>
          `${d.tier}: Δ ${d.deltaPct >= 0 ? '+' : ''}${d.deltaPct.toFixed(1)} pp (upstream ${(d.upstreamPct * 100).toFixed(1)}% vs 90d ${(d.empiricalPct * 100).toFixed(1)}%)`
      );
      fields.push({
        name: '⚠ Divergence (>20 pp)',
        value: lines.join('\n'),
        inline: false,
      });
    }
  }

  fields.push(buildDisclosureField());
  embed.addFields(fields);

  return embed;
};

/**
 * Input shape for the /leaderboard embed and the daily-digest poster.
 *
 * `entries` is a fixed-shape projection (we never accept a Prisma row directly
 * here) so the builder remains decoupled from the generated client.
 */
export interface LeaderboardEntryInput {
  rank: number;
  pull: {
    id: string;
    cardName: string | null;
    setName: string | null;
    gradingCompany: string | null;
    grade: string | null;
    packSlug: string;
    frontImageUrl: string | null;
    serial: string | null;
  };
  netGainUsdCents: number;
  fmvUsdCents: number | null;
}

export interface LeaderboardEmbedInput {
  windowStartAt: Date;
  windowEndAt: Date;
  entries: LeaderboardEntryInput[];
  title?: string;
  description?: string;
}

/**
 * SSRF allowlist for the rank-1 thumbnail. Mirrors the set in
 * `src/lib/share-card/render.ts` so the leaderboard embed cannot point an
 * embed thumbnail at an internal host. Defense in depth: discord.js would
 * reject non-http(s) URLs anyway, but pinning the host set prevents an
 * attacker-controlled CDN from being referenced via an embed thumbnail.
 *
 * If a future Pull arrives with an imageUrl outside this set, the embed
 * simply omits the thumbnail rather than rendering it unsafely.
 */
const LEADERBOARD_THUMBNAIL_ALLOWED_HOSTS = new Set<string>([
  'cdn.renaiss.xyz',
  'images.renaiss.xyz',
  'api.renaiss.xyz',
  'api.renaissos.com',
]);

const isSafeThumbnailUrl = (raw: string | null | undefined): raw is string => {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    return LEADERBOARD_THUMBNAIL_ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
};

const RANK_EMOJI: Record<number, string> = {
  1: '1st',
  2: '2nd',
  3: '3rd',
  4: '4th',
  5: '5th',
};

const rankLabel = (rank: number): string => {
  return RANK_EMOJI[rank] ?? `#${rank}`;
};

const formatGradeSuffix = (
  gradingCompany: string | null,
  grade: string | null
): string => {
  const parts: string[] = [];
  if (typeof gradingCompany === 'string' && gradingCompany.length > 0) {
    parts.push(gradingCompany);
  }
  if (typeof grade === 'string' && grade.length > 0) {
    parts.push(grade);
  }
  return parts.length > 0 ? ` (${parts.join(' ')})` : '';
};

const truncateLine = (text: string, max: number): string => {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
};

/**
 * Build the "Pull of the Day" leaderboard embed. Top entries are rendered as
 * a numbered list (rank label + card name + grade + signed net gain). The
 * rank-1 image becomes the embed thumbnail when the URL passes the SSRF
 * allowlist; otherwise the embed renders without a thumbnail rather than
 * exposing an attacker-controlled host.
 *
 * The disclosure field + footer are present on every output (safety mandate).
 */
export const buildLeaderboardEmbed = (
  input: LeaderboardEmbedInput
): EmbedBuilder => {
  const title =
    typeof input.title === 'string' && input.title.length > 0
      ? input.title
      : 'Pull of the Day';

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0xf1c40f) // gold for "highlight reel"
    .setFooter(discordEmbedFooter());

  // Stable description: optional intro line, then trailing 24h window label.
  const startEpoch = Math.floor(input.windowStartAt.getTime() / 1000);
  const endEpoch = Math.floor(input.windowEndAt.getTime() / 1000);
  const windowLine = `Window: <t:${startEpoch}:f> → <t:${endEpoch}:f>`;
  const descLines: string[] = [];
  if (typeof input.description === 'string' && input.description.length > 0) {
    descLines.push(truncateLine(input.description, 1000));
  }
  descLines.push(windowLine);
  embed.setDescription(descLines.join('\n'));

  const entries = Array.isArray(input.entries) ? input.entries.slice(0, 5) : [];

  const fields: APIEmbedField[] = [];

  if (entries.length === 0) {
    fields.push({
      name: 'No pulls yet',
      value: 'No qualifying pulls in the trailing 24h window.',
      inline: false,
    });
  } else {
    const lines = entries.map((e) => {
      const name =
        e.pull.cardName ?? e.pull.setName ?? `Pull ${e.pull.id.slice(0, 8)}`;
      const gradeSuffix = formatGradeSuffix(
        e.pull.gradingCompany,
        e.pull.grade
      );
      const gain = formatSignedUsdFromCents(e.netGainUsdCents);
      const packTag = e.pull.packSlug ? ` · ${e.pull.packSlug}` : '';
      const line = `**${rankLabel(e.rank)}** ${truncateLine(name, 60)}${gradeSuffix}${packTag} — ${gain}`;
      return truncateLine(line, 240);
    });
    fields.push({
      name: 'Top pulls',
      value: lines.join('\n'),
      inline: false,
    });
  }

  fields.push(buildDisclosureField());
  embed.addFields(fields);

  // Rank-1 thumbnail, SSRF-checked. Skip silently on a non-allowed host.
  const headlineImage = entries.length > 0 ? entries[0].pull.frontImageUrl : null;
  if (isSafeThumbnailUrl(headlineImage)) {
    try {
      embed.setThumbnail(headlineImage);
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} leaderboard setThumbnail rejected reason=${formatErr(err)}`
      );
    }
  }

  embed.setTimestamp(input.windowEndAt);

  return embed;
};

/**
 * Build a generic error embed. Always carries the footer + the disclosure
 * field so even error responses satisfy the safety mandate.
 */
export const buildErrorEmbed = (message: string): EmbedBuilder => {
  const safeMsg =
    typeof message === 'string' && message.length > 0
      ? message
      : 'Something went wrong. Please try again in a moment.';

  return new EmbedBuilder()
    .setTitle('Error')
    .setColor(0xe74c3c)
    .setDescription(safeMsg)
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());
};

/**
 * Distinct warning-tone embed for Renaiss OS Index rate-limit (429) responses.
 * Framed as a soft "paused" state, not a hard error, because the quota resets
 * automatically and the user can just come back later.
 */
export const buildIndexRateLimitedEmbed = (): EmbedBuilder => {
  return new EmbedBuilder()
    .setTitle('Live data paused')
    .setColor(0xf39c12)
    .setDescription(
      'Renaiss OS Index is currently rate-limiting our backend. Live data is paused until the daily quota resets — try again in a few hours.',
    )
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());
};

const formatErr = (err: unknown): string => {
  return err instanceof Error ? err.message : String(err);
};

// ---------------------------------------------------------------------------
// D6 - AI track embed builders (/explain, /listing).
// ---------------------------------------------------------------------------

/**
 * Minimal source shape duplicated here so this module does NOT import from
 * `lib/anthropic`. The real `Source` type from `retriever.ts` is structurally
 * compatible (id + name + url + excerpt + optional confidence + fetchedAt).
 */
export interface AiSource {
  id: number;
  name: string;
  url: string;
  excerpt: string;
  confidence?: 'prime' | 'high' | 'medium' | 'low';
  fetchedAt: string;
}

export interface ExplainEmbedInput {
  question: string;
  text: string;
  sources: AiSource[];
  refused?: { reason: string };
}

export interface ListingEmbedInput {
  text: string;
  sources: AiSource[];
  card: {
    name: string | null;
    setName: string | null;
    grade: string | null;
    cardId: string | null;
    cert: string | null;
  };
  rangeLowUsdCents: number | null;
  rangeMidUsdCents: number | null;
  rangeHighUsdCents: number | null;
  comparableCount: number;
  primaryFmvUsdCents: number | null;
  primarySource: string;
  confidence: 'prime' | 'high' | 'medium' | 'low' | null;
  refused?: { reason: string };
}

const truncate = (text: string, max: number): string => {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
};

const renderSourceField = (sources: AiSource[]): APIEmbedField => {
  if (sources.length === 0) {
    return { name: 'Sources', value: 'No sources available.', inline: false };
  }
  const lines = sources.map(
    (s) =>
      `[source-${s.id}] ${s.name}${s.confidence ? ` (${s.confidence})` : ''}\n${s.url}`
  );
  const joined = lines.join('\n');
  return {
    name: 'Sources',
    value: truncate(joined, 1020),
    inline: false,
  };
};

/**
 * Build the /explain embed. Header carries the user's question, body is the
 * cited AI answer, footer carries the disclosure marker. Sources collapse
 * into an embed field.
 */
export const buildExplainEmbed = (result: ExplainEmbedInput): EmbedBuilder => {
  const isRefusal = result.refused !== undefined;
  const title = isRefusal ? 'Refused' : 'Explain';
  const color = isRefusal ? 0xe67e22 : 0x9b59b6;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(truncate(result.text, 4000))
    .setFooter(discordEmbedFooter());

  const fields: APIEmbedField[] = [];
  if (typeof result.question === 'string' && result.question.length > 0) {
    fields.push({
      name: 'Question',
      value: truncate(result.question, 200),
      inline: false,
    });
  }
  if (!isRefusal) {
    fields.push(renderSourceField(result.sources));
  }
  fields.push(buildDisclosureField());
  embed.addFields(fields);
  return embed;
};

const formatCentsCompact = (c: number | null): string => {
  if (c === null || c === undefined || !Number.isFinite(c)) return '–';
  return c >= 100000
    ? `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `$${(c / 100).toFixed(2)}`;
};

const formatRangeLine = (
  low: number | null,
  mid: number | null,
  high: number | null
): string => `Low ${formatCentsCompact(low)} • Mid ${formatCentsCompact(mid)} • High ${formatCentsCompact(high)}`;

/**
 * Build the /listing embed. Top of embed shows the deterministic range; the
 * AI's explanation is the description body. Sources collapse into a field.
 */
export const buildListingEmbed = (result: ListingEmbedInput): EmbedBuilder => {
  const isRefusal = result.refused !== undefined;
  const title = isRefusal
    ? 'Refused'
    : result.card.name
      ? `Listing: ${result.card.name}${result.card.grade ? ` (${result.card.grade})` : ''}`
      : 'Suggested listing range';
  const color = isRefusal ? 0xe67e22 : 0x1abc9c;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(truncate(result.text, 4000))
    .setFooter(discordEmbedFooter());

  const fields: APIEmbedField[] = [];

  if (!isRefusal) {
    fields.push({
      name: 'Suggested range',
      value: formatRangeLine(
        result.rangeLowUsdCents,
        result.rangeMidUsdCents,
        result.rangeHighUsdCents
      ),
      inline: false,
    });
    fields.push({
      name: 'Primary FMV',
      value: `${formatCentsCompact(result.primaryFmvUsdCents)} (${result.primarySource})${result.confidence ? ` • ${result.confidence}` : ''}`,
      inline: false,
    });
    fields.push({
      name: 'Comparable trades',
      value: String(result.comparableCount),
      inline: true,
    });
    if (result.card.cert) {
      fields.push({ name: 'Cert', value: result.card.cert, inline: true });
    }
    if (result.card.cardId) {
      fields.push({ name: 'Card ID', value: result.card.cardId, inline: true });
    }
    fields.push(renderSourceField(result.sources));
  }
  fields.push(buildDisclosureField());
  embed.addFields(fields);
  return embed;
};


/**
 * `/browse` slash command.
 *
 * Rich filter surface over the Renaiss `/v0/marketplace` endpoint. Options:
 *   - search       free text (min 3 chars enforced by the upstream)
 *   - category     POKEMON | ONE_PIECE   (pinned choices)
 *   - grading      PSA | BGS | CGC | SGC (pinned choices)
 *   - grade        free text (e.g. "10 Gem Mint")
 *   - year         yearRange (e.g. "2023" or "2020-2025")
 *   - listed_only  boolean toggle
 *   - sort         listDate | fmvPriceInUsd | year | grade | name (pinned)
 *   - order        asc | desc
 *   - limit        1..5 (Discord embed density cap; upstream can go to 100)
 *
 * Response is a single message with up to 5 embeds side-by-side (one embed
 * per card so each keeps its own thumbnail). The last embed carries the
 * disclosure field + footer per the SAFETY mandate.
 *
 * Rate limit: 5 req / min / user via `discord:command:browse:<userId>` using
 * the shared `consumeRateLimitToken` bucket (Postgres, atomic).
 */

import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import type { Command } from '../command-registry.ts';
import { buildDisclosureField, buildErrorEmbed } from '../embed-builders.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';
import {
  renaissApi,
  RenaissApiError,
  parsePriceCents,
} from '../../renaiss/index.ts';
import type { RenaissMarketplaceItem } from '../../renaiss/index.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';

const LOG_PREFIX = '[browse]';

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const MIN_LIMIT = 1;
const MAX_LIMIT = 5;
const DEFAULT_LIMIT = 5;

const YEAR_RANGE_RX = /^\d{4}(-\d{4})?$/;

const consumeBrowseToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:browse:${userId}`, 5, 5);
};

const buildRateLimitedEmbed = (): EmbedBuilder => {
  return new EmbedBuilder()
    .setTitle('Slow down please')
    .setColor(0xe67e22)
    .setDescription(
      'You have hit the /browse rate limit (5 per minute). Try again shortly.'
    )
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());
};

const formatUsdFromCents = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '–';
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) {
    return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  return `$${dollars.toFixed(2)}`;
};

/**
 * Ask price arrives as an integer string in USDT wei (1e18) or the sentinel
 * "NO-ASK-PRICE". We render it as a rounded USDT value; downstream displays
 * treat USDT as a $1 stablecoin for the ballpark.
 */
const formatAskUsdt = (raw: string | null | undefined): string => {
  if (typeof raw !== 'string' || raw.length === 0) return '–';
  if (raw === 'NO-ASK-PRICE') return 'Not listed';
  if (!/^\d+$/.test(raw)) return '–';
  // 1 USDT = 1e18 wei on Renaiss main API (per file 15 §4.2).
  const wei = BigInt(raw);
  const denom = 10n ** 18n;
  const whole = wei / denom;
  const asNumber = Number(whole);
  if (!Number.isFinite(asNumber)) return '–';
  return `${asNumber.toLocaleString('en-US')} USDT`;
};

const truncate = (text: string, max: number): string => {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
};

/**
 * Build the Renaiss-side deep link for the collectible. The public web app
 * mounts collectibles at `/collectibles/<tokenId>`. If Renaiss later renames
 * this path the embed URL will 404 gracefully but not crash the command.
 */
const buildRenaissUrl = (tokenId: string): string => {
  return `https://renaiss.xyz/collectibles/${encodeURIComponent(tokenId)}`;
};

/**
 * Pull the image URL out of `attributes[]` if present. The live shape often
 * omits a top-level imageUrl and stashes the image under an attribute-like
 * `Image` trait; check both.
 */
const extractImageUrl = (item: RenaissMarketplaceItem): string | null => {
  const raw = (item as Record<string, unknown>).imageUrl;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (Array.isArray(item.attributes)) {
    for (const a of item.attributes) {
      if (!a || typeof a !== 'object') continue;
      const trait = (a as { trait?: unknown }).trait;
      const value = (a as { value?: unknown }).value;
      if (typeof trait !== 'string' || typeof value !== 'string') continue;
      const lower = trait.toLowerCase();
      if (lower === 'image' || lower === 'imageurl' || lower === 'image url') {
        if (value.startsWith('https://')) return value;
      }
    }
  }
  return null;
};

const buildItemEmbed = (item: RenaissMarketplaceItem, rank: number): EmbedBuilder => {
  const nameLine = truncate(item.name, 200);
  const title = `#${rank}  ${nameLine}`;

  const fmvCents = parsePriceCents(item.fmvPriceInUSD ?? null);
  const askDisplay = formatAskUsdt(item.askPriceInUSDT ?? null);

  const subtitleParts: string[] = [];
  if (item.setName) subtitleParts.push(item.setName);
  if (item.cardNumber) subtitleParts.push(`#${item.cardNumber}`);
  const gradeLabel = [item.gradingCompany, item.grade]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ');
  if (gradeLabel.length > 0) subtitleParts.push(gradeLabel);

  const embed = new EmbedBuilder()
    .setTitle(truncate(title, 256))
    .setColor(0x3498db)
    .setURL(buildRenaissUrl(item.tokenId));

  if (subtitleParts.length > 0) {
    embed.setDescription(subtitleParts.join('  ·  '));
  }

  const image = extractImageUrl(item);
  if (image !== null) {
    try {
      embed.setThumbnail(image);
    } catch (err) {
      console.warn(`${LOG_PREFIX} setThumbnail rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  embed.addFields(
    {
      name: 'FMV (USD)',
      value: formatUsdFromCents(fmvCents),
      inline: true,
    },
    {
      name: 'Ask',
      value: askDisplay,
      inline: true,
    },
    {
      name: 'Year',
      value: String(item.year),
      inline: true,
    }
  );

  return embed;
};

/**
 * Summarize the active filter set for the header embed title.
 */
const summarizeFilters = (
  filters: {
    search?: string;
    categoryFilter?: string;
    grading?: string;
    grade?: string;
    yearRange?: string;
    listedOnly?: boolean;
  },
  count: number
): string => {
  const bits: string[] = [];
  if (filters.grading && filters.grade) {
    bits.push(`${filters.grading} ${filters.grade}`);
  } else if (filters.grading) {
    bits.push(filters.grading);
  } else if (filters.grade) {
    bits.push(filters.grade);
  }
  if (filters.search) bits.push(`"${filters.search}"`);
  if (filters.categoryFilter) {
    bits.push(filters.categoryFilter === 'POKEMON' ? 'Pokemon' : 'One Piece');
  }
  if (filters.yearRange) bits.push(filters.yearRange);
  if (filters.listedOnly === true) bits.push('listed');
  const suffix = bits.length > 0 ? bits.join(', ') : 'marketplace results';
  return `${count} ${suffix}`;
};

interface ParsedOptions {
  search?: string;
  categoryFilter?: 'POKEMON' | 'ONE_PIECE';
  gradingCompanyFilter?: 'PSA' | 'BGS' | 'CGC' | 'SGC';
  gradeFilter?: string;
  yearRange?: string;
  listedOnly?: boolean;
  sortBy?:
    | 'fmvPriceInUsd'
    | 'listDate'
    | 'year'
    | 'grade'
    | 'name';
  sortOrder?: 'asc' | 'desc';
  limit: number;
}

const parseInteractionOptions = (
  interaction: ChatInputCommandInteraction
): { ok: true; options: ParsedOptions } | { ok: false; message: string } => {
  const search = interaction.options.getString('search', false)?.trim() || undefined;
  if (search !== undefined && (search.length < 3 || search.length > 150)) {
    return { ok: false, message: 'search must be 3..150 characters.' };
  }

  const category = interaction.options.getString('category', false) as
    | 'POKEMON'
    | 'ONE_PIECE'
    | null;
  const grading = interaction.options.getString('grading', false) as
    | 'PSA'
    | 'BGS'
    | 'CGC'
    | 'SGC'
    | null;
  const grade = interaction.options.getString('grade', false)?.trim() || undefined;
  if (grade !== undefined && grade.length > 64) {
    return { ok: false, message: 'grade is too long (max 64 chars).' };
  }

  const year = interaction.options.getString('year', false)?.trim() || undefined;
  if (year !== undefined && !YEAR_RANGE_RX.test(year)) {
    return { ok: false, message: 'year must look like "2023" or "2020-2025".' };
  }

  const listedOnly = interaction.options.getBoolean('listed_only', false);
  const sortBy = interaction.options.getString('sort', false) as
    | 'fmvPriceInUsd'
    | 'listDate'
    | 'year'
    | 'grade'
    | 'name'
    | null;
  const sortOrder = interaction.options.getString('order', false) as
    | 'asc'
    | 'desc'
    | null;

  const limitRaw = interaction.options.getInteger('limit', false);
  let limit = DEFAULT_LIMIT;
  if (typeof limitRaw === 'number' && Number.isFinite(limitRaw)) {
    if (limitRaw < MIN_LIMIT || limitRaw > MAX_LIMIT) {
      return {
        ok: false,
        message: `limit must be in [${MIN_LIMIT}, ${MAX_LIMIT}].`,
      };
    }
    limit = Math.floor(limitRaw);
  }

  return {
    ok: true,
    options: {
      search,
      categoryFilter: category ?? undefined,
      gradingCompanyFilter: grading ?? undefined,
      gradeFilter: grade,
      yearRange: year,
      listedOnly: listedOnly ?? undefined,
      sortBy: sortBy ?? undefined,
      sortOrder: sortOrder ?? undefined,
      limit,
    },
  };
};

const handleBrowse = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const parsed = parseInteractionOptions(interaction);
  if (!parsed.ok) {
    await interaction.editReply({
      embeds: [buildErrorEmbed(parsed.message)],
    });
    return;
  }

  const opts = parsed.options;

  let response;
  try {
    response = await renaissApi.searchMarketplace({
      search: opts.search,
      categoryFilter: opts.categoryFilter,
      gradingCompanyFilter: opts.gradingCompanyFilter,
      gradeFilter: opts.gradeFilter,
      yearRange: opts.yearRange,
      listedOnly: opts.listedOnly,
      sortBy: opts.sortBy,
      sortOrder: opts.sortOrder,
      limit: opts.limit,
    });
  } catch (err) {
    if (err instanceof RenaissApiError) {
      console.warn(`${LOG_PREFIX} upstream failed status=${err.status}`);
      if (err.status !== null && err.status >= 400 && err.status < 500) {
        await interaction.editReply({
          embeds: [
            buildErrorEmbed(
              'Renaiss rejected those filters. Try a different combination.'
            ),
          ],
        });
        return;
      }
      await interaction.editReply({
        embeds: [
          buildErrorEmbed(
            'Renaiss marketplace unavailable right now. Please try again shortly.'
          ),
        ],
      });
      return;
    }
    console.error(`${LOG_PREFIX} unexpected error:`, err);
    await interaction.editReply({
      embeds: [
        buildErrorEmbed('Something went wrong. Please try again in a moment.'),
      ],
    });
    return;
  }

  const items = response.collection.slice(0, opts.limit);

  if (items.length === 0) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          `No marketplace results matched. Renaiss total: ${response.pagination.total}.`
        ),
      ],
    });
    return;
  }

  const summaryTitle = summarizeFilters(
    {
      search: opts.search,
      categoryFilter: opts.categoryFilter,
      grading: opts.gradingCompanyFilter,
      grade: opts.gradeFilter,
      yearRange: opts.yearRange,
      listedOnly: opts.listedOnly,
    },
    items.length
  );

  const headerEmbed = new EmbedBuilder()
    .setTitle(truncate(summaryTitle, 256))
    .setColor(0x1abc9c)
    .setDescription(
      `Showing ${items.length} of ${response.pagination.total.toLocaleString('en-US')} matching collectibles. Page offset ${response.pagination.offset}.`
    );

  const cardEmbeds = items.map((c, i) => buildItemEmbed(c, i + 1));
  const embeds = [headerEmbed, ...cardEmbeds];

  // Drop the disclosure field + footer onto the LAST embed only, so Discord
  // shows exactly one disclosure banner per message.
  const last = embeds[embeds.length - 1];
  last.addFields(buildDisclosureField()).setFooter(discordEmbedFooter());

  await interaction.editReply({ embeds });
  console.log(
    `${LOG_PREFIX} ok user=${interaction.user.id} count=${items.length} total=${response.pagination.total}`
  );
};

const data = new SlashCommandBuilder()
  .setName('browse')
  .setDescription('Browse the Renaiss marketplace with rich filters.')
  .addStringOption((opt) =>
    opt
      .setName('search')
      .setDescription('Free-text search (3-150 chars).')
      .setRequired(false)
      .setMinLength(3)
      .setMaxLength(150)
  )
  .addStringOption((opt) =>
    opt
      .setName('category')
      .setDescription('Category filter.')
      .setRequired(false)
      .addChoices(
        { name: 'Pokemon', value: 'POKEMON' },
        { name: 'One Piece', value: 'ONE_PIECE' }
      )
  )
  .addStringOption((opt) =>
    opt
      .setName('grading')
      .setDescription('Grading company.')
      .setRequired(false)
      .addChoices(
        { name: 'PSA', value: 'PSA' },
        { name: 'BGS', value: 'BGS' },
        { name: 'CGC', value: 'CGC' },
        { name: 'SGC', value: 'SGC' }
      )
  )
  .addStringOption((opt) =>
    opt
      .setName('grade')
      .setDescription('Grade text (e.g. "10 Gem Mint").')
      .setRequired(false)
      .setMaxLength(64)
  )
  .addStringOption((opt) =>
    opt
      .setName('year')
      .setDescription('Year or range: "2023" or "2020-2025".')
      .setRequired(false)
      .setMaxLength(9)
  )
  .addBooleanOption((opt) =>
    opt
      .setName('listed_only')
      .setDescription('Only show currently-listed items.')
      .setRequired(false)
  )
  .addStringOption((opt) =>
    opt
      .setName('sort')
      .setDescription('Sort field.')
      .setRequired(false)
      .addChoices(
        { name: 'Newest listed', value: 'listDate' },
        { name: 'Price (FMV)', value: 'fmvPriceInUsd' },
        { name: 'Year', value: 'year' },
        { name: 'Grade', value: 'grade' },
        { name: 'Name', value: 'name' }
      )
  )
  .addStringOption((opt) =>
    opt
      .setName('order')
      .setDescription('Sort order.')
      .setRequired(false)
      .addChoices(
        { name: 'Ascending', value: 'asc' },
        { name: 'Descending', value: 'desc' }
      )
  )
  .addIntegerOption((opt) =>
    opt
      .setName('limit')
      .setDescription(`Results to show (${MIN_LIMIT}-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`)
      .setRequired(false)
      .setMinValue(MIN_LIMIT)
      .setMaxValue(MAX_LIMIT)
  );

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const allowed = await consumeBrowseToken(interaction.user.id);
  if (!allowed) {
    await interaction.reply({
      embeds: [buildRateLimitedEmbed()],
      ...ephemeral,
    });
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error(`${LOG_PREFIX} deferReply failed:`, err);
    return;
  }

  try {
    await handleBrowse(interaction);
  } catch (err) {
    console.error(`${LOG_PREFIX} handler unexpected error:`, err);
    try {
      await interaction.editReply({
        embeds: [
          buildErrorEmbed('Something went wrong. Please try again in a moment.'),
        ],
      });
    } catch (replyErr) {
      console.error(`${LOG_PREFIX} editReply failed:`, replyErr);
    }
  }
};

export const browseCommand: Command = { data, handler };

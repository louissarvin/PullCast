/**
 * `/packs` slash command.
 *
 *  /packs                       list all active packs (page 1, up to 10 per embed)
 *  /packs slug:<value>          jump directly to pack detail
 *  /packs include_inactive:true admin-visible flag; folds archived / soldout packs
 *
 * The list output is a single embed (not multiple) with up to 10 packs;
 * additional pages are unlocked with the "Next page" button. The button
 * customId encodes the page + `includeInactive` toggle so the handler is
 * stateless.
 *
 * Rate limit: 5 req / min / user via `discord:command:packs:<userId>`.
 *
 * All pack imagery is defensively passed through `sanitizeImageUrl` before
 * being handed to Discord; the live list surface does not carry image URLs
 * today so this is a preemptive guard for when the upstream adds one.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import type { ButtonRoute, Command } from '../command-registry.ts';
import { buildDisclosureField, buildErrorEmbed } from '../embed-builders.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';
import {
  renaissApi,
  RenaissApiError,
  type RenaissPackListItem,
} from '../../renaiss/index.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';
import { sanitizeImageUrl, sanitizeShortText } from '../../../utils/urlAllowlist.ts';

const LOG_PREFIX = '[packs]';

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const PAGE_SIZE = 10;

const consumePacksToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:packs:${userId}`, 5, 5);
};

const buildRateLimitedEmbed = (): EmbedBuilder =>
  new EmbedBuilder()
    .setTitle('Slow down please')
    .setColor(0xe67e22)
    .setDescription(
      'You have hit the /packs rate limit (5 per minute). Try again shortly.'
    )
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());

// ---------------------------------------------------------------------------
// Price / value helpers
//
// The list surface emits values as digit strings:
//   - `priceInUsdt`         -> USDT wei (18 decimals). Divide by 1e18 for USDT.
//   - `expectedValueInUsd`  -> string integer USD (e.g. "10463" -> "$10,463").
//   - `featuredCardFmvInUsd`-> string integer USD (e.g. "380000" -> "$380,000").
//
// Absence, non-digit input, and NaN all collapse to `null` so the formatter
// prints an em-dash without exploding on a schema drift.
// ---------------------------------------------------------------------------

const parseUsdtWeiToUsdt = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return null;
  try {
    const wei = BigInt(raw);
    // 1e18. Integer USDT is fine for display; hackathon packs are round values.
    const usdt = Number(wei / 10n ** 18n);
    return Number.isFinite(usdt) ? usdt : null;
  } catch {
    return null;
  }
};

const parseIntStringToUsd = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const formatUsd = (usd: number | null): string => {
  if (usd === null) return '-';
  if (Math.abs(usd) >= 1000) {
    return `$${usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  return `$${usd.toFixed(2)}`;
};

const formatUsdt = (usdt: number | null): string => {
  if (usdt === null) return '-';
  return `${usdt.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT`;
};

const stageEmoji = (stage: string): string => {
  switch (stage) {
    case 'active':
      return '🟢';
    case 'countdown':
      return '🟡';
    case 'soldout-or-restocking':
      return '🟠';
    case 'archived':
      return '⚪️';
    default:
      return '⚫️';
  }
};

// ---------------------------------------------------------------------------
// List embed builder + pagination
// ---------------------------------------------------------------------------

interface PageState {
  page: number;
  includeInactive: boolean;
}

const PACKS_BUTTON_PREFIX = 'packs:page:';

const encodeButtonId = (state: PageState): string =>
  `${PACKS_BUTTON_PREFIX}${state.page}:${state.includeInactive ? '1' : '0'}`;

const decodeButtonId = (customId: string): PageState | null => {
  if (!customId.startsWith(PACKS_BUTTON_PREFIX)) return null;
  const rest = customId.slice(PACKS_BUTTON_PREFIX.length);
  const [pageStr, incStr] = rest.split(':');
  const page = Number.parseInt(pageStr ?? '', 10);
  if (!Number.isInteger(page) || page < 0 || page > 100) return null;
  const includeInactive = incStr === '1';
  return { page, includeInactive };
};

const buildListEmbed = (
  packs: RenaissPackListItem[],
  state: PageState,
  totalPages: number
): EmbedBuilder => {
  const start = state.page * PAGE_SIZE;
  const slice = packs.slice(start, start + PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setTitle(
      state.includeInactive
        ? 'Renaiss Packs (all)'
        : 'Renaiss Packs (active + countdown)'
    )
    .setColor(0x3498db)
    .setDescription(
      totalPages > 1
        ? `Page ${state.page + 1} of ${totalPages}  ·  ${packs.length} total`
        : `${packs.length} total`
    );

  for (const p of slice) {
    // Sanitize every string before it goes into an embed field so a malicious
    // upstream cannot inject markdown or line-splitters.
    const name = sanitizeShortText(p.name, 128) ?? p.slug;
    const author = sanitizeShortText(p.author, 64);
    const priceUsdt = parseUsdtWeiToUsdt(p.priceInUsdt);
    const evUsd = parseIntStringToUsd(p.expectedValueInUsd);

    const emoji = stageEmoji(p.stage);
    const authorLine = author ? ` · ${author}` : '';
    const fieldName = `${emoji} ${name} (${p.slug})`.slice(0, 256);
    const fieldValue = [
      `Type: \`${p.packType}\`  Stage: \`${p.stage}\`${authorLine}`,
      `Price: ${formatUsdt(priceUsdt)}  ·  EV: ${formatUsd(evUsd)}`,
    ]
      .join('\n')
      .slice(0, 1024);

    embed.addFields({ name: fieldName, value: fieldValue, inline: false });
  }

  embed.addFields(buildDisclosureField()).setFooter(discordEmbedFooter());
  return embed;
};

const buildPagerRow = (
  state: PageState,
  totalPages: number
): ActionRowBuilder<ButtonBuilder> | null => {
  if (totalPages <= 1) return null;
  const prev = new ButtonBuilder()
    .setCustomId(
      encodeButtonId({ page: Math.max(0, state.page - 1), includeInactive: state.includeInactive })
    )
    .setLabel('◀ Prev page')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(state.page === 0);
  const next = new ButtonBuilder()
    .setCustomId(
      encodeButtonId({ page: state.page + 1, includeInactive: state.includeInactive })
    )
    .setLabel('Next page ▶')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(state.page + 1 >= totalPages);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(prev, next);
};

// ---------------------------------------------------------------------------
// Pack detail embed
// ---------------------------------------------------------------------------

const buildDetailEmbed = (pack: RenaissPackListItem | Record<string, unknown>): EmbedBuilder => {
  const p = pack as RenaissPackListItem & { imageUrl?: unknown };
  const name = sanitizeShortText(p.name, 128) ?? p.slug ?? 'Pack';
  const author = sanitizeShortText(p.author, 64);
  const priceUsdt = parseUsdtWeiToUsdt(p.priceInUsdt);
  const evUsd = parseIntStringToUsd(p.expectedValueInUsd);
  const featuredFmv = parseIntStringToUsd(p.featuredCardFmvInUsd);
  const safeImage = sanitizeImageUrl(p.imageUrl);

  const embed = new EmbedBuilder()
    .setTitle(`${stageEmoji(p.stage ?? '')} ${name}`)
    .setColor(0x3498db)
    .setDescription(
      // Cap description at 512 chars so the embed stays compact; anything
      // longer would push the disclosure field off the initial view.
      (sanitizeShortText(p.description, 512) ?? '').slice(0, 512) || ' '
    );

  embed.addFields(
    { name: 'Slug', value: `\`${p.slug ?? '-'}\``, inline: true },
    { name: 'Type', value: `\`${p.packType ?? '-'}\``, inline: true },
    { name: 'Stage', value: `\`${p.stage ?? '-'}\``, inline: true },
    { name: 'Price', value: formatUsdt(priceUsdt), inline: true },
    { name: 'Expected value', value: formatUsd(evUsd), inline: true },
    { name: 'Featured FMV', value: formatUsd(featuredFmv), inline: true }
  );
  if (author) embed.addFields({ name: 'Author', value: author, inline: false });
  if (safeImage !== null) embed.setThumbnail(safeImage);

  embed.addFields(buildDisclosureField()).setFooter(discordEmbedFooter());
  return embed;
};

// ---------------------------------------------------------------------------
// Fetch + render helpers
// ---------------------------------------------------------------------------

const fetchAllPacks = async (
  includeInactive: boolean
): Promise<RenaissPackListItem[] | { error: string }> => {
  try {
    return await renaissApi.getPacks({ includeInactive });
  } catch (err) {
    if (err instanceof RenaissApiError) {
      console.warn(`${LOG_PREFIX} upstream failed status=${err.status}`);
    } else {
      console.error(`${LOG_PREFIX} unexpected fetch error:`, err);
    }
    return { error: 'Renaiss main API unavailable. Please try again shortly.' };
  }
};

const fetchPackBySlug = async (
  slug: string
): Promise<RenaissPackListItem | { error: string; notFound?: boolean }> => {
  try {
    // getPack returns the wrapped/canonical pack shape used by the indexer
    // (fields at root after the transform). Downstream we treat the result as
    // a shape-tolerant record.
    const raw = (await renaissApi.getPack(slug)) as unknown as Record<string, unknown>;
    return {
      slug: (raw.slug as string) ?? slug,
      name: (raw.name as string) ?? slug,
      packType: (raw.packType as string) ?? 'perpetual',
      stage: (raw.stage as string) ?? 'unknown',
      description: (raw.description as string) ?? null,
      author: raw.author as string | undefined,
      priceInUsdt:
        typeof raw.priceInUsdt === 'string' || typeof raw.priceInUsdt === 'number'
          ? raw.priceInUsdt
          : null,
      expectedValueInUsd:
        typeof raw.expectedValueInUsd === 'string' ||
        typeof raw.expectedValueInUsd === 'number'
          ? raw.expectedValueInUsd
          : null,
      featuredCardFmvInUsd:
        typeof raw.featuredCardFmvInUsd === 'string' ||
        typeof raw.featuredCardFmvInUsd === 'number'
          ? raw.featuredCardFmvInUsd
          : null,
    };
  } catch (err) {
    if (err instanceof RenaissApiError) {
      if (err.status !== null && err.status >= 400 && err.status < 500) {
        return { error: `Pack \`${slug}\` not found.`, notFound: true };
      }
      console.warn(`${LOG_PREFIX} pack detail failed status=${err.status}`);
    } else {
      console.error(`${LOG_PREFIX} pack detail unexpected:`, err);
    }
    return { error: 'Renaiss main API unavailable. Please try again shortly.' };
  }
};

// ---------------------------------------------------------------------------
// Interaction handlers
// ---------------------------------------------------------------------------

const handleList = async (
  interaction: ChatInputCommandInteraction,
  includeInactive: boolean
): Promise<void> => {
  const result = await fetchAllPacks(includeInactive);
  if (!Array.isArray(result)) {
    await interaction.editReply({
      embeds: [buildErrorEmbed(result.error)],
    });
    return;
  }
  if (result.length === 0) {
    await interaction.editReply({
      embeds: [buildErrorEmbed('No packs returned from the Renaiss main API.')],
    });
    return;
  }

  const state: PageState = { page: 0, includeInactive };
  const totalPages = Math.max(1, Math.ceil(result.length / PAGE_SIZE));
  const embed = buildListEmbed(result, state, totalPages);
  const row = buildPagerRow(state, totalPages);

  await interaction.editReply(
    row === null ? { embeds: [embed] } : { embeds: [embed], components: [row] }
  );

  console.log(
    `${LOG_PREFIX} list ok user=${interaction.user.id} includeInactive=${includeInactive} totalPacks=${result.length}`
  );
};

const handleDetail = async (
  interaction: ChatInputCommandInteraction,
  slug: string
): Promise<void> => {
  // Reuse the same slug validation as the REST route to avoid drift.
  if (!/^[a-z0-9-]{1,64}$/i.test(slug)) {
    await interaction.editReply({
      embeds: [buildErrorEmbed('Invalid pack slug.')],
    });
    return;
  }
  const result = await fetchPackBySlug(slug.toLowerCase());
  if ('error' in result && typeof result.error === 'string') {
    await interaction.editReply({ embeds: [buildErrorEmbed(result.error)] });
    return;
  }
  const embed = buildDetailEmbed(result as RenaissPackListItem);
  await interaction.editReply({ embeds: [embed] });
  console.log(`${LOG_PREFIX} detail ok user=${interaction.user.id} slug=${slug}`);
};

const data = new SlashCommandBuilder()
  .setName('packs')
  .setDescription('List Renaiss card packs or view a single pack by slug.')
  .addStringOption((opt) =>
    opt
      .setName('slug')
      .setDescription('Pack slug (e.g. eden-pack). If provided, jumps to detail view.')
      .setRequired(false)
      .setMaxLength(64)
  )
  .addBooleanOption((opt) =>
    opt
      .setName('include_inactive')
      .setDescription('Include archived and soldout-or-restocking packs.')
      .setRequired(false)
  );

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const allowed = await consumePacksToken(interaction.user.id);
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

  const slug = interaction.options.getString('slug', false);
  const includeInactive =
    interaction.options.getBoolean('include_inactive', false) === true;

  try {
    if (typeof slug === 'string' && slug.length > 0) {
      await handleDetail(interaction, slug);
    } else {
      await handleList(interaction, includeInactive);
    }
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

// ---------------------------------------------------------------------------
// Button handler: pagination
// ---------------------------------------------------------------------------

const paginationButton: ButtonRoute = {
  prefix: PACKS_BUTTON_PREFIX,
  handler: async (interaction: ButtonInteraction): Promise<void> => {
    // Reuse the per-user token bucket to keep button spam bounded.
    const allowed = await consumePacksToken(interaction.user.id);
    if (!allowed) {
      await interaction.reply({
        embeds: [buildRateLimitedEmbed()],
        ...ephemeral,
      });
      return;
    }
    const state = decodeButtonId(interaction.customId);
    if (state === null) {
      await interaction.reply({
        embeds: [buildErrorEmbed('Invalid navigation state.')],
        ...ephemeral,
      });
      return;
    }
    try {
      await interaction.deferUpdate();
    } catch (err) {
      console.error(`${LOG_PREFIX} deferUpdate failed:`, err);
      return;
    }
    const result = await fetchAllPacks(state.includeInactive);
    if (!Array.isArray(result)) {
      await interaction.editReply({
        embeds: [buildErrorEmbed(result.error)],
        components: [],
      });
      return;
    }
    const totalPages = Math.max(1, Math.ceil(result.length / PAGE_SIZE));
    const clampedPage = Math.min(state.page, totalPages - 1);
    const clampedState: PageState = { page: clampedPage, includeInactive: state.includeInactive };
    const embed = buildListEmbed(result, clampedState, totalPages);
    const row = buildPagerRow(clampedState, totalPages);
    await interaction.editReply(
      row === null
        ? { embeds: [embed], components: [] }
        : { embeds: [embed], components: [row] }
    );
  },
};

export const packsCommand: Command = {
  data,
  handler,
  buttons: [paginationButton],
};

// Exports for tests.
export const __testables = {
  parseUsdtWeiToUsdt,
  parseIntStringToUsd,
  encodeButtonId,
  decodeButtonId,
  buildListEmbed,
  buildDetailEmbed,
  PAGE_SIZE,
};

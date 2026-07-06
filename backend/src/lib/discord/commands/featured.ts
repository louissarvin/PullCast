/**
 * `/featured` slash command (D8).
 *
 * Renders 1..3 CardSummary tiles from the Renaiss OS Index featured-movers
 * endpoint. Each card shows name, price, 7d delta, confidence dot, and the
 * thumbnail (as the embed thumbnail on the first card, and inline links for
 * the rest).
 *
 * We show one embed per card so image thumbnails render side-by-side in the
 * Discord client (Discord stacks multiple embeds vertically but each keeps its
 * own thumbnail). Cap is 3 embeds because Discord's per-message limit is 10
 * embeds but visual density beyond 3 is poor.
 *
 * Rate limit: 5 req / min / user via `discord:command:featured:<userId>`.
 */

import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import type { Command } from '../command-registry.ts';
import {
  buildDisclosureField,
  buildErrorEmbed,
  buildIndexRateLimitedEmbed,
} from '../embed-builders.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';
import {
  getCachedFeatured,
  IndexApiError,
} from '../../renaiss-index/index.ts';
import type { CardSummary } from '../../renaiss-index/index.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';

const LOG_PREFIX = '[featured]';

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const MIN_LIMIT = 1;
const MAX_LIMIT = 3;
const DEFAULT_LIMIT = 3;

const consumeFeaturedToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:featured:${userId}`, 5, 5);
};

const buildRateLimitedEmbed = (): EmbedBuilder => {
  return new EmbedBuilder()
    .setTitle('Slow down please')
    .setColor(0xe67e22)
    .setDescription(
      'You have hit the /featured rate limit (5 per minute). Try again shortly.'
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

const formatDelta = (pct: number | null | undefined): string => {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '–';
  const arrow = pct >= 0 ? '▲' : '▼';
  const sign = pct >= 0 ? '+' : '';
  return `${arrow} ${sign}${pct.toFixed(2)}%`;
};

const confidenceDot = (conf: 'prime' | 'high' | 'medium' | 'low' | null | undefined): string => {
  if (conf === 'high') return '🟢';
  if (conf === 'medium') return '🟡';
  if (conf === 'low') return '🔴';
  return '⚪️';
};

const embedColorForDelta = (pct: number | null | undefined): number => {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 0x7f8c8d;
  return pct >= 0 ? 0x2ecc71 : 0xe74c3c;
};

const gameLabel = (game: CardSummary['game']): string => {
  switch (game) {
    case 'pokemon':
      return 'Pokemon';
    case 'one-piece':
      return 'One Piece';
    case 'sports':
      return 'Sports';
    default:
      return game;
  }
};

/**
 * Build the deep-link URL to the card's Renaiss OS page. `card.href` is a
 * relative path (`/card/...`); combine it with the public origin.
 */
const buildCardUrl = (card: CardSummary): string | null => {
  if (typeof card.href !== 'string' || card.href.length === 0) return null;
  if (card.href.startsWith('http://') || card.href.startsWith('https://')) {
    return card.href;
  }
  const rel = card.href.startsWith('/') ? card.href : `/${card.href}`;
  return `https://renaissos.com${rel}`;
};

const buildCardEmbed = (card: CardSummary, rank: number): EmbedBuilder => {
  const nameParts: string[] = [card.name];
  if (typeof card.variation === 'string' && card.variation.length > 0) {
    nameParts.push(`(${card.variation})`);
  }
  const title = `#${rank}  ${nameParts.join(' ')}`;

  const subtitle: string[] = [];
  if (typeof card.setName === 'string' && card.setName.length > 0) {
    subtitle.push(card.setName);
  }
  if (typeof card.cardNumber === 'string' && card.cardNumber.length > 0) {
    subtitle.push(`#${card.cardNumber}`);
  }
  subtitle.push(card.gradeLabel);

  const url = buildCardUrl(card);
  const embed = new EmbedBuilder()
    .setTitle(title.slice(0, 256))
    .setColor(embedColorForDelta(card.deltaPct))
    .setDescription(subtitle.join('  ·  '));

  if (url !== null) embed.setURL(url);

  // Prefer the smaller thumbnail; fall back to imageUrl. Discord will only
  // render the URL if it passes its own hotlink checks; the Blob storage
  // origin `bhshyxmgzwogzgcf.public.blob.vercel-storage.com` is Renaiss-owned.
  const thumb =
    typeof card.imageUrlThumb === 'string' && card.imageUrlThumb.length > 0
      ? card.imageUrlThumb
      : typeof card.imageUrl === 'string' && card.imageUrl.length > 0
        ? card.imageUrl
        : null;
  if (thumb !== null) embed.setThumbnail(thumb);

  embed.addFields(
    {
      name: 'Price',
      value: formatUsdFromCents(card.priceUsdCents),
      inline: true,
    },
    {
      name: 'Delta',
      value: formatDelta(card.deltaPct),
      inline: true,
    },
    {
      name: 'Confidence',
      value: `${confidenceDot(card.confidence)} ${card.confidence ?? 'unknown'}`,
      inline: true,
    },
    {
      name: 'Game',
      value: gameLabel(card.game),
      inline: true,
    }
  );

  if (typeof card.lastSaleAt === 'string' && card.lastSaleAt.length > 0) {
    const epoch = Math.floor(new Date(card.lastSaleAt).getTime() / 1000);
    if (Number.isFinite(epoch)) {
      embed.addFields({
        name: 'Last sale',
        value: `<t:${epoch}:R>`,
        inline: true,
      });
    }
  }

  return embed;
};

const handleFeatured = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const limitRaw = interaction.options.getInteger('limit', false);
  let limit = DEFAULT_LIMIT;
  if (typeof limitRaw === 'number' && Number.isFinite(limitRaw)) {
    if (limitRaw < MIN_LIMIT || limitRaw > MAX_LIMIT) {
      await interaction.editReply({
        embeds: [
          buildErrorEmbed(
            `Limit must be an integer in [${MIN_LIMIT}, ${MAX_LIMIT}].`
          ),
        ],
      });
      return;
    }
    limit = Math.floor(limitRaw);
  }

  let cards: CardSummary[];
  try {
    cards = await getCachedFeatured(limit);
  } catch (err) {
    if (err instanceof IndexApiError) {
      console.warn(`${LOG_PREFIX} upstream failed status=${err.status}`);
      if (err.status === 429) {
        await interaction.editReply({
          embeds: [buildIndexRateLimitedEmbed()],
        });
        return;
      }
      await interaction.editReply({
        embeds: [
          buildErrorEmbed(
            'Renaiss OS Index unavailable right now. Please try again shortly.'
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

  if (cards.length === 0) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed('No featured movers returned by the Renaiss OS Index.'),
      ],
    });
    return;
  }

  const trimmed = cards.slice(0, limit);
  const embeds = trimmed.map((c, i) => buildCardEmbed(c, i + 1));
  // Only decorate the FIRST embed with the disclosure field + footer so we do
  // not repeat the beta banner three times. Discord shows one footer per
  // message-level embed; putting it on the last embed is idiomatic.
  const last = embeds[embeds.length - 1];
  last.addFields(buildDisclosureField()).setFooter(discordEmbedFooter());

  await interaction.editReply({ embeds });
  console.log(
    `${LOG_PREFIX} ok user=${interaction.user.id} limit=${limit} rendered=${embeds.length}`
  );
};

const data = new SlashCommandBuilder()
  .setName('featured')
  .setDescription('Top-mover cards across the Renaiss OS Index.')
  .addIntegerOption((opt) =>
    opt
      .setName('limit')
      .setDescription(`How many cards to show (${MIN_LIMIT}-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`)
      .setRequired(false)
      .setMinValue(MIN_LIMIT)
      .setMaxValue(MAX_LIMIT)
  );

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const allowed = await consumeFeaturedToken(interaction.user.id);
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
    await handleFeatured(interaction);
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

export const featuredCommand: Command = { data, handler };

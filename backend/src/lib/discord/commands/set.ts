/**
 * `/set` slash command (Gap 3).
 *
 * Renders a Renaiss OS Index set listing:
 *   - Set name, card count, aggregate FMV (sum of card `priceUsdCents`)
 *   - Top 5 cards by price, each with a thumbnail, price, confidence dot
 *
 * The set slug is the 2nd path segment of any card `href` returned by
 * `/v1/cards/featured` or `/v1/search`. Users can find valid slugs by running
 * `/market game:pokemon` and reading a top mover's `href`.
 *
 * Rate limit: 5 req / min / user via `discord:command:set:<userId>`.
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
  IndexApiError,
  renaissIndex,
} from '../../renaiss-index/index.ts';
import type {
  CardSummary,
  IndexGameSlug,
  IndexSetListing,
} from '../../renaiss-index/index.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';

const LOG_PREFIX = '[set]';

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const KNOWN_GAMES: ReadonlyArray<{ name: string; value: IndexGameSlug }> = [
  { name: 'Pokemon', value: 'pokemon' },
  { name: 'One Piece', value: 'one-piece' },
  { name: 'Sports', value: 'sports' },
];

/**
 * Slug validation matches the upstream URL segment shape and rejects any
 * path-traversal attempts. Keep in sync with the REST route's regex.
 */
const SLUG_RE = /^[a-z0-9-]{1,120}$/;

const consumeSetToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:set:${userId}`, 5, 5);
};

const buildRateLimitedEmbed = (): EmbedBuilder => {
  return new EmbedBuilder()
    .setTitle('Slow down please')
    .setColor(0xe67e22)
    .setDescription(
      'You have hit the /set rate limit (5 per minute). Try again shortly.'
    )
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());
};

const formatUsd = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '–';
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) {
    return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  return `$${dollars.toFixed(2)}`;
};

const confidenceDot = (
  conf: 'prime' | 'high' | 'medium' | 'low' | null | undefined
): string => {
  if (conf === 'high') return '🟢';
  if (conf === 'medium') return '🟡';
  if (conf === 'low') return '🔴';
  return '⚪️';
};

/**
 * Sum priceUsdCents across the set to a total FMV estimate. Nulls are
 * skipped rather than treated as zero — a null priceUsdCents means "not
 * priced yet" and should not depress the aggregate.
 */
const aggregateFmv = (cards: CardSummary[]): { totalCents: number; pricedCount: number } => {
  let total = 0;
  let priced = 0;
  for (const card of cards) {
    const p = card.priceUsdCents;
    if (typeof p === 'number' && Number.isFinite(p) && p >= 0) {
      total += p;
      priced += 1;
    }
  }
  return { totalCents: total, pricedCount: priced };
};

const topByPrice = (cards: CardSummary[], n: number): CardSummary[] => {
  return [...cards]
    .filter((c) => typeof c.priceUsdCents === 'number' && c.priceUsdCents !== null)
    .sort((a, b) => (b.priceUsdCents ?? 0) - (a.priceUsdCents ?? 0))
    .slice(0, n);
};

const buildCardUrl = (card: CardSummary): string | null => {
  if (typeof card.href !== 'string' || card.href.length === 0) return null;
  if (card.href.startsWith('http://') || card.href.startsWith('https://')) {
    return card.href;
  }
  const rel = card.href.startsWith('/') ? card.href : `/${card.href}`;
  return `https://renaissos.com${rel}`;
};

const buildSetEmbed = (listing: IndexSetListing): EmbedBuilder => {
  const cards = Array.isArray(listing.cards) ? listing.cards : [];
  const { totalCents, pricedCount } = aggregateFmv(cards);
  const top = topByPrice(cards, 5);

  const embed = new EmbedBuilder()
    .setTitle((listing.setName ?? listing.setSegment).slice(0, 256))
    .setColor(0x3498db)
    .setDescription(
      [
        listing.setCode ? `Set code: \`${listing.setCode}\`` : null,
        `Slug: \`${listing.setSegment}\``,
      ]
        .filter((s): s is string => s !== null)
        .join('\n')
    );

  const thumb = top[0]?.imageUrlThumb ?? top[0]?.imageUrl ?? null;
  if (typeof thumb === 'string' && thumb.length > 0) {
    embed.setThumbnail(thumb);
  }

  embed.addFields(
    {
      name: 'Card count',
      value: String(listing.cardCount),
      inline: true,
    },
    {
      name: 'Aggregate FMV',
      value: `${formatUsd(totalCents)}${pricedCount < cards.length ? ` (${pricedCount}/${cards.length} priced)` : ''}`,
      inline: true,
    },
    {
      name: 'Game',
      value: listing.game,
      inline: true,
    }
  );

  if (top.length > 0) {
    const lines = top.map((card, i) => {
      const url = buildCardUrl(card);
      const nameText =
        typeof card.variation === 'string' && card.variation.length > 0
          ? `${card.name} (${card.variation})`
          : card.name;
      const label = url !== null ? `[${nameText}](${url})` : nameText;
      const num = typeof card.cardNumber === 'string' ? ` #${card.cardNumber}` : '';
      return `**${i + 1}.** ${label}${num} · ${card.gradeLabel} · ${formatUsd(card.priceUsdCents)} · ${confidenceDot(card.confidence)}`;
    });
    embed.addFields({
      name: 'Top 5 by price',
      value: lines.join('\n').slice(0, 1024),
    });
  }

  embed.addFields(buildDisclosureField()).setFooter(discordEmbedFooter());
  return embed;
};

const handleSet = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const gameRaw = interaction.options.getString('game', true);
  const setRaw = interaction.options.getString('set', true);

  const game = gameRaw.trim();
  const setSlug = setRaw.trim();

  if (!KNOWN_GAMES.some((g) => g.value === game)) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          `Unknown game. Must be one of: ${KNOWN_GAMES.map((g) => g.value).join(', ')}.`
        ),
      ],
    });
    return;
  }
  if (!SLUG_RE.test(setSlug)) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          'Invalid set slug. Use lowercase kebab-case, e.g. `pokemon-ex-unseen-forces`.'
        ),
      ],
    });
    return;
  }

  let listing: IndexSetListing;
  try {
    listing = await renaissIndex.getSet(game as IndexGameSlug, setSlug);
  } catch (err) {
    if (err instanceof IndexApiError) {
      if (err.status === 404) {
        await interaction.editReply({
          embeds: [
            buildErrorEmbed(
              `Set \`${setSlug}\` not found for game \`${game}\`. Try /market to find a valid slug.`
            ),
          ],
        });
        return;
      }
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

  await interaction.editReply({ embeds: [buildSetEmbed(listing)] });
  console.log(
    `${LOG_PREFIX} ok user=${interaction.user.id} game=${game} set=${setSlug} cards=${listing.cardCount}`
  );
};

const data = new SlashCommandBuilder()
  .setName('set')
  .setDescription('Renaiss OS Index set listing (card count, aggregate FMV, top 5).')
  .addStringOption((opt) =>
    opt
      .setName('game')
      .setDescription('Game slug.')
      .setRequired(true)
      .addChoices(...KNOWN_GAMES)
  )
  .addStringOption((opt) =>
    opt
      .setName('set')
      .setDescription('Set slug (e.g. pokemon-ex-unseen-forces).')
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(120)
  );

const handler = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const allowed = await consumeSetToken(interaction.user.id);
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
    await handleSet(interaction);
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

export const setCommand: Command = { data, handler };


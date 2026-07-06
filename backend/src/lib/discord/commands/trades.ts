/**
 * `/trades` slash command — live Renaiss OS Index recent trades feed.
 *
 * Mirrors web `/trades` and CLI `pullcast trades`. Shows up to 5 recent
 * cross-market graded sales with source attribution.
 *
 * Rate limit: 5 req / min / user.
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
import { IndexApiError, renaissIndex } from '../../renaiss-index/index.ts';
import type { IndexTrade } from '../../renaiss-index/index.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';

const LOG_PREFIX = '[trades]';

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const MIN_LIMIT = 1;
const MAX_LIMIT = 5;
const DEFAULT_LIMIT = 5;

const consumeTradesToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:trades:${userId}`, 5, 5);
};

const formatUsd = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '–';
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) {
    return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  return `$${dollars.toFixed(2)}`;
};

const buildRateLimitedEmbed = (): EmbedBuilder => {
  return new EmbedBuilder()
    .setTitle('Slow down please')
    .setColor(0xe67e22)
    .setDescription('You have hit the /trades rate limit (5 per minute). Try again shortly.')
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());
};

const buildTradeEmbed = (trade: IndexTrade, rank: number): EmbedBuilder => {
  const card = trade.card;
  const name = typeof card?.name === 'string' ? card.name : 'Unknown card';
  const grade = trade.gradeLabel ?? '—';
  const price = formatUsd(trade.priceUsdCents);
  const when =
    typeof trade.observedAt === 'string'
      ? trade.observedAt.slice(0, 16).replace('T', ' ')
      : '—';
  const src = trade.displayName ?? trade.source ?? 'Index';

  const embed = new EmbedBuilder()
    .setTitle(`#${rank}  ${name}`.slice(0, 256))
    .setColor(0x3498db)
    .setDescription(`${grade}  ·  ${price}`)
    .addFields(
      { name: 'When', value: when, inline: true },
      { name: 'Source', value: src.slice(0, 256), inline: true }
    );

  const thumb =
    typeof card?.imageUrl === 'string' && card.imageUrl.length > 0 ? card.imageUrl : null;
  if (thumb !== null) embed.setThumbnail(thumb);

  if (typeof card?.href === 'string' && card.href.length > 0) {
    const url = card.href.startsWith('http')
      ? card.href
      : `https://index.renaissos.com${card.href.startsWith('/') ? card.href : `/${card.href}`}`;
    embed.setURL(url);
  }

  return embed.addFields(buildDisclosureField()).setFooter(discordEmbedFooter());
};

const handleTrades = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const rawLimit = interaction.options.getInteger('limit') ?? DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, rawLimit));

  let trades: IndexTrade[];
  try {
    trades = await renaissIndex.getRecentTrades({ limit });
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
          buildErrorEmbed('Renaiss OS Index is temporarily unavailable.'),
        ],
      });
      return;
    }
    console.error(`${LOG_PREFIX} unexpected error:`, err);
    await interaction.editReply({
      embeds: [buildErrorEmbed('Could not fetch recent trades.')],
    });
    return;
  }

  if (trades.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('No recent trades')
          .setColor(0x7f8c8d)
          .setDescription('The Index API returned an empty trades list.')
          .addFields(buildDisclosureField())
          .setFooter(discordEmbedFooter()),
      ],
    });
    return;
  }

  const embeds = trades.slice(0, limit).map((t, i) => buildTradeEmbed(t, i + 1));
  await interaction.editReply({ embeds });
  console.log(`${LOG_PREFIX} ok user=${interaction.user.id} count=${trades.length}`);
};

const data = new SlashCommandBuilder()
  .setName('trades')
  .setDescription('Recent graded card trades from Renaiss OS Index (live feed).')
  .addIntegerOption((opt) =>
    opt
      .setName('limit')
      .setDescription(`How many trades to show (${MIN_LIMIT}–${MAX_LIMIT}).`)
      .setMinValue(MIN_LIMIT)
      .setMaxValue(MAX_LIMIT)
  );

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const allowed = await consumeTradesToken(interaction.user.id);
  if (!allowed) {
    await interaction.reply({ embeds: [buildRateLimitedEmbed()], ...ephemeral });
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error(`${LOG_PREFIX} deferReply failed:`, err);
    return;
  }

  try {
    await handleTrades(interaction);
  } catch (err) {
    console.error(`${LOG_PREFIX} handler error:`, err);
    await interaction.editReply({
      embeds: [buildErrorEmbed('Something went wrong fetching trades.')],
    });
  }
};

export const tradesCommand: Command = { data, handler };

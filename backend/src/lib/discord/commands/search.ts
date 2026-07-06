/**
 * `/search` slash command — Renaiss OS Index free-text card search.
 *
 * Distinct from `/browse` (main API marketplace). Queries GET /v1/search.
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
import type { IndexSearchResult } from '../../renaiss-index/index.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';

const LOG_PREFIX = '[search]';

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const MIN_QUERY_LEN = 2;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;

const consumeSearchToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:search:${userId}`, 5, 5);
};

const formatUsd = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '–';
  return `$${(cents / 100).toFixed(2)}`;
};

const buildRateLimitedEmbed = (): EmbedBuilder => {
  return new EmbedBuilder()
    .setTitle('Slow down please')
    .setColor(0xe67e22)
    .setDescription('You have hit the /search rate limit (5 per minute). Try again shortly.')
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());
};

const resultLine = (r: IndexSearchResult, i: number): string => {
  const name = typeof r.name === 'string' ? r.name : 'Unknown';
  const grade = typeof r.gradeLabel === 'string' ? r.gradeLabel : '—';
  const price = formatUsd(r.priceUsdCents ?? null);
  const conf = typeof r.confidence === 'string' ? ` (${r.confidence})` : '';
  return `**${i}.** ${name.slice(0, 48)} — ${grade} — ${price}${conf}`;
};

const handleSearch = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const query = interaction.options.getString('query', true).trim();
  if (query.length < MIN_QUERY_LEN) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(`Search query must be at least ${MIN_QUERY_LEN} characters.`),
      ],
    });
    return;
  }

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, interaction.options.getInteger('limit') ?? DEFAULT_LIMIT)
  );

  let results: IndexSearchResult[];
  try {
    results = await renaissIndex.searchCards(query, { limit });
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
          buildErrorEmbed('Renaiss OS Index search is temporarily unavailable.'),
        ],
      });
      return;
    }
    console.error(`${LOG_PREFIX} unexpected error:`, err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Search failed.')] });
    return;
  }

  if (results.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`No results for "${query.slice(0, 80)}"`)
          .setColor(0x7f8c8d)
          .setDescription('Try a different card name or cert number.')
          .addFields(buildDisclosureField())
          .setFooter(discordEmbedFooter()),
      ],
    });
    return;
  }

  const lines = results.slice(0, limit).map((r, i) => resultLine(r, i + 1));
  const embed = new EmbedBuilder()
    .setTitle(`Index search: ${query.slice(0, 100)}`)
    .setColor(0x9b59b6)
    .setDescription(lines.join('\n').slice(0, 4000))
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());

  await interaction.editReply({ embeds: [embed] });
  console.log(`${LOG_PREFIX} ok user=${interaction.user.id} q="${query}" n=${results.length}`);
};

const data = new SlashCommandBuilder()
  .setName('search')
  .setDescription('Search graded cards on Renaiss OS Index (not marketplace).')
  .addStringOption((opt) =>
    opt
      .setName('query')
      .setDescription('Card name or cert (min 2 chars).')
      .setRequired(true)
      .setMinLength(MIN_QUERY_LEN)
      .setMaxLength(120)
  )
  .addIntegerOption((opt) =>
    opt
      .setName('limit')
      .setDescription(`Results to show (1–${MAX_LIMIT}).`)
      .setMinValue(1)
      .setMaxValue(MAX_LIMIT)
  );

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const allowed = await consumeSearchToken(interaction.user.id);
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
    await handleSearch(interaction);
  } catch (err) {
    console.error(`${LOG_PREFIX} handler error:`, err);
    await interaction.editReply({
      embeds: [buildErrorEmbed('Something went wrong running search.')],
    });
  }
};

export const searchCommand: Command = { data, handler };

/**
 * `/market` slash command (D8).
 *
 * Overview and drill-down for the Renaiss OS Index tiles. When called without
 * a `game` option, we render the Pokemon tile as the default (it's the flagship
 * per the docs). When a `game` option is provided we render that tile's drill-
 * down data (deltas, constituent count, top movers).
 *
 * The rendered embed carries:
 *  - Index value (2dp)
 *  - Deltas d7 / d30 / d365 with color-coded arrows (green up, red down)
 *  - 30-day ASCII sparkline of `usdCents`
 *  - Top movers (up to 3) with deltaPct
 *  - Beta footer via the shared disclosure helper
 *
 * Rate limit: 5 req / min / user via the atomic RateLimitBucket
 * `discord:command:market:<userId>`.
 *
 * All embeds route through `buildDisclosureField` + `discordEmbedFooter` so
 * the beta / not-financial-advice mandate is enforced by the same code path
 * every other command uses.
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
  getCachedIndices,
  getCachedIndicesByGame,
  renderSparklineFromSeriesPoints,
  IndexApiError,
} from '../../renaiss-index/index.ts';
import type {
  IndexTile,
  IndexDetail,
  IndexGameSlug,
} from '../../renaiss-index/index.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';

const LOG_PREFIX = '[market]';

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const KNOWN_GAMES: ReadonlyArray<{ name: string; value: IndexGameSlug }> = [
  { name: 'Pokemon', value: 'pokemon' },
  { name: 'One Piece', value: 'one-piece' },
  { name: 'Sports', value: 'sports' },
];

const consumeMarketToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:market:${userId}`, 5, 5);
};

const buildRateLimitedEmbed = (): EmbedBuilder => {
  return new EmbedBuilder()
    .setTitle('Slow down please')
    .setColor(0xe67e22)
    .setDescription(
      'You have hit the /market rate limit (5 per minute). Try again shortly.'
    )
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());
};

const formatValue = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  return v.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

/**
 * Format a delta percentage with a color-coded arrow. `>` renders green in
 * Discord's ANSI code-block, `<` renders red. We wrap output in a code fence
 * per line so Discord applies the color; combining into one field value.
 */
const formatDelta = (label: string, pct: number | null | undefined): string => {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return `\`${label}\` –`;
  }
  const arrow = pct >= 0 ? '▲' : '▼';
  const sign = pct >= 0 ? '+' : '';
  return `\`${label}\` ${arrow} ${sign}${pct.toFixed(2)}%`;
};

const embedColorForD7 = (d7: number | null | undefined): number => {
  if (typeof d7 !== 'number' || !Number.isFinite(d7)) return 0x7f8c8d;
  return d7 >= 0 ? 0x2ecc71 : 0xe74c3c;
};

const buildTopMoversField = (
  movers: IndexTile['topMovers']
): string => {
  if (!Array.isArray(movers) || movers.length === 0) return '–';
  const lines = movers.slice(0, 3).map((m, i) => {
    const pct = m.deltaPct;
    const pctStr =
      typeof pct === 'number' && Number.isFinite(pct)
        ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
        : '–';
    const arrow =
      typeof pct === 'number' && Number.isFinite(pct)
        ? pct >= 0
          ? '▲'
          : '▼'
        : '';
    const bits: string[] = [];
    if (typeof m.setCode === 'string' && m.setCode.length > 0) bits.push(m.setCode);
    if (typeof m.cardNumber === 'string' && m.cardNumber.length > 0)
      bits.push(`#${m.cardNumber}`);
    const suffix = bits.length > 0 ? ` (${bits.join(' · ')})` : '';
    return `${i + 1}. ${m.name}${suffix} — ${arrow} ${pctStr}`;
  });
  return lines.join('\n');
};

const gameLabel = (game: IndexGameSlug): string => {
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
 * Build the /market embed for a single index tile. Works for both the
 * top-level `IndexTile` shape (from `getCachedIndices`) and the extended
 * `IndexDetail` shape (from `getCachedIndicesByGame`) since IndexDetail is a
 * superset.
 */
const buildMarketEmbed = (tile: IndexTile | IndexDetail): EmbedBuilder => {
  const spark = renderSparklineFromSeriesPoints(tile.sparkline);
  const deltas = [
    formatDelta('7d ', tile.deltas.d7),
    formatDelta('30d', tile.deltas.d30),
    formatDelta('1y ', tile.deltas.d365),
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle(tile.label)
    .setColor(embedColorForD7(tile.deltas.d7))
    .setDescription(
      `**Value:** ${formatValue(tile.value)}  ·  **Base:** ${formatValue(tile.base)}`
    )
    .addFields(
      { name: 'Deltas', value: deltas, inline: false },
      {
        name: '30d sparkline',
        value: spark.length > 0 ? `\`${spark}\`` : '–',
        inline: false,
      },
      {
        name: 'Top movers',
        value: buildTopMoversField(tile.topMovers),
        inline: false,
      },
      {
        name: 'Basket',
        value: `${tile.constituentCount} cards  ·  rebalance ${tile.rebalance}`,
        inline: false,
      }
    );

  if (tile.updatedAt) {
    const epoch = Math.floor(new Date(tile.updatedAt).getTime() / 1000);
    if (Number.isFinite(epoch)) {
      embed.setTimestamp(new Date(epoch * 1000));
    }
  }

  embed.addFields(buildDisclosureField()).setFooter(discordEmbedFooter());
  return embed;
};

const handleMarket = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const gameRaw = interaction.options.getString('game', false);
  const game =
    typeof gameRaw === 'string' && (KNOWN_GAMES.map((g) => g.value) as string[]).includes(gameRaw)
      ? (gameRaw as IndexGameSlug)
      : null;

  try {
    if (game === null) {
      const tiles = await getCachedIndices();
      if (tiles.length === 0) {
        await interaction.editReply({
          embeds: [
            buildErrorEmbed(
              'No indices returned by the Renaiss OS Index right now.'
            ),
          ],
        });
        return;
      }
      // Default view: Pokemon tile is the flagship; render it plus a short
      // list of the other games' values as a comparison field.
      const primary =
        tiles.find((t) => t.game === 'pokemon') ?? tiles[0];
      const embed = buildMarketEmbed(primary);
      const otherLines = tiles
        .filter((t) => t.game !== primary.game)
        .map(
          (t) =>
            `${gameLabel(t.game)}: ${formatValue(t.value)} (${formatDelta('7d', t.deltas.d7).replace(/^`.+?`\s/, '')})`
        );
      if (otherLines.length > 0) {
        embed.addFields({
          name: 'Other indices',
          value: otherLines.join('\n'),
          inline: false,
        });
      }
      await interaction.editReply({ embeds: [embed] });
      console.log(
        `${LOG_PREFIX} default ok user=${interaction.user.id} tiles=${tiles.length}`
      );
      return;
    }

    const detail = await getCachedIndicesByGame(game);
    const embed = buildMarketEmbed(detail);
    embed.addFields({
      name: 'Window',
      value: `${detail.windowDays}d  ·  base ${detail.baseDate ?? '–'}`,
      inline: false,
    });
    await interaction.editReply({ embeds: [embed] });
    console.log(
      `${LOG_PREFIX} drilldown ok user=${interaction.user.id} game=${game}`
    );
  } catch (err) {
    if (err instanceof IndexApiError) {
      console.warn(
        `${LOG_PREFIX} upstream failed game=${game ?? 'default'} status=${err.status}`
      );
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
    console.error(
      `${LOG_PREFIX} unexpected error game=${game ?? 'default'}:`,
      err
    );
    await interaction.editReply({
      embeds: [
        buildErrorEmbed('Something went wrong. Please try again in a moment.'),
      ],
    });
  }
};

const data = new SlashCommandBuilder()
  .setName('market')
  .setDescription('Renaiss OS Index tiles: value, deltas, sparkline, top movers.')
  .addStringOption((opt) =>
    opt
      .setName('game')
      .setDescription('Optional game to drill into (default: overview).')
      .setRequired(false)
      .addChoices(...KNOWN_GAMES)
  );

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const allowed = await consumeMarketToken(interaction.user.id);
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
    await handleMarket(interaction);
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

export const marketCommand: Command = { data, handler };


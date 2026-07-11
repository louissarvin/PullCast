/**
 * `/odds` slash command.
 *
 * Returns rolling 90-day pull-economy stats for a tracked Renaiss pack:
 *   - Sample size (total pulls with known netGain)
 *   - Mean + median net P&L
 *   - Win rate (pulls with netGain > 0)
 *   - Top 5 pulls in window
 *   - Per-tier breakdown
 *
 * Hard rules honored:
 *  - `pack` choice list comes from `INDEXER_TRACKED_PACKS`; off-list values
 *    are rejected with a helpful error embed.
 *  - If `n < 10` the embed is a "not enough data" error embed (no bogus stats).
 *  - All embeds via `embed-builders.ts` (`buildOddsEmbed`, `buildErrorEmbed`).
 *  - Per-user rate-limit via the atomic `consumeRateLimitToken` bucket
 *    `discord:command:odds:<userId>` (10 capacity, 10 refill / min).
 *  - Defers BEFORE making the DB query; the rate-limit check happens first so
 *    an exhausted user does not consume a deferred reply slot.
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
  buildOddsEmbed,
} from '../embed-builders.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';
import { INDEXER_TRACKED_PACKS } from '../../../config/main-config.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';
import {
  computeDivergence,
  computeEmpiricalTierFrequency,
  computeOddsStats,
  computeTierFrequency,
  ODDS_MIN_SAMPLE,
} from '../../odds/index.ts';
import { renaissApi } from '../../renaiss/index.ts';

const LOG_PREFIX = '[odds]';

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const consumeOddsToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:odds:${userId}`, 10, 10);
};

const isTrackedPack = (slug: string): boolean => {
  return INDEXER_TRACKED_PACKS.includes(slug);
};

const trackedPacksHint = (): string => {
  if (INDEXER_TRACKED_PACKS.length === 0) {
    return 'No packs are currently tracked.';
  }
  return `Tracked packs: ${INDEXER_TRACKED_PACKS.join(', ')}.`;
};

const data = (() => {
  const builder = new SlashCommandBuilder()
    .setName('odds')
    .setDescription('Pull economy stats for a tracked Renaiss pack (last 90 days).')
    .addStringOption((opt) => {
      opt
        .setName('pack')
        .setDescription('Tracked pack slug (e.g. eden-pack).')
        .setRequired(true);
      // Discord caps choices at 25; we use whatever subset INDEXER_TRACKED_PACKS
      // exposes (typically 3). If the env var is empty the user can still
      // type-in a value but it will be rejected at handler time.
      for (const slug of INDEXER_TRACKED_PACKS.slice(0, 25)) {
        opt.addChoices({ name: slug, value: slug });
      }
      return opt;
    });
  return builder;
})();

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  // Rate-limit BEFORE deferring so an exhausted user does not consume a
  // deferred reply slot.
  const allowed = await consumeOddsToken(interaction.user.id);
  if (!allowed) {
    const slowEmbed = new EmbedBuilder()
      .setTitle('Slow down please')
      .setColor(0xe67e22)
      .setDescription(
        'You have hit the /odds rate limit (10 per minute). Try again shortly.'
      )
      .addFields(buildDisclosureField())
      .setFooter(discordEmbedFooter());
    await interaction.reply({ embeds: [slowEmbed], ...ephemeral });
    return;
  }

  const packRaw = interaction.options.getString('pack', true);
  const pack = packRaw.trim();

  if (!isTrackedPack(pack)) {
    // Reply directly (no defer) since the validation is cheap and immediate.
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          `Pack "${pack}" is not tracked by PullCast. ${trackedPacksHint()}`
        ),
      ],
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

  // Fetch stats + upstream recent activity + empirical tier freq concurrently.
  // Upstream failure is non-fatal: we still render the empirical block.
  const [statsResult, upstreamResult, empiricalTierFreqResult] =
    await Promise.allSettled([
      computeOddsStats(pack),
      renaissApi.getPackRecent(pack),
      computeEmpiricalTierFrequency(pack),
    ]);

  if (statsResult.status !== 'fulfilled') {
    console.error(
      `${LOG_PREFIX} computeOddsStats failed pack=${pack}:`,
      statsResult.reason
    );
    await interaction.editReply({
      embeds: [
        buildErrorEmbed('Failed to compute odds. Please try again in a moment.'),
      ],
    });
    return;
  }
  const stats = statsResult.value;

  if (stats.totalPulls < ODDS_MIN_SAMPLE) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          `Not enough data for ${pack} yet (n=${stats.totalPulls}). Check back later.`
        ),
      ],
    });
    console.log(
      `${LOG_PREFIX} insufficient sample pack=${pack} n=${stats.totalPulls} user=${interaction.user.id}`
    );
    return;
  }

  // Upstream block (nullable on failure).
  const upstreamTiers =
    upstreamResult.status === 'fulfilled'
      ? computeTierFrequency(upstreamResult.value.map((p) => p.tier))
      : null;
  const empiricalTiers =
    empiricalTierFreqResult.status === 'fulfilled'
      ? empiricalTierFreqResult.value
      : null;

  const divergence =
    upstreamTiers && empiricalTiers
      ? computeDivergence(upstreamTiers.entries, empiricalTiers.entries, 20)
      : [];

  const embed = buildOddsEmbed({
    packSlug: stats.packSlug,
    totalPulls: stats.totalPulls,
    meanNetGainUsdCents: stats.meanNetGainUsdCents,
    medianNetGainUsdCents: stats.medianNetGainUsdCents,
    winRate: stats.winRate,
    top5: stats.top5.map((t) => ({
      netGainUsdCents: t.netGainUsdCents,
      grade: t.grade,
      gradingCompany: t.gradingCompany,
    })),
    byTier: stats.byTier,
    windowDays: stats.windowDays,
    upstreamRecent: upstreamTiers
      ? { sampleSize: upstreamTiers.total, tierFrequency: upstreamTiers.entries }
      : {
          sampleSize: 0,
          tierFrequency: [],
          error: 'Renaiss recent-activity feed unavailable',
        },
    divergence,
  });

  await interaction.editReply({ embeds: [embed] });
  console.log(
    `${LOG_PREFIX} ok pack=${pack} n=${stats.totalPulls} winRate=${stats.winRate.toFixed(3)} user=${interaction.user.id}`
  );
};

export const oddsCommand: Command = { data, handler };


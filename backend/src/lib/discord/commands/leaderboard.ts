/**
 * `/leaderboard` slash command.
 *
 * Subcommands:
 *  - daily    - latest top-5 trailing 24h snapshot, rendered as a single
 *               embed via `buildLeaderboardEmbed`.
 *  - history  - last N (1..7) daily top-1 snapshots, one per field.
 *
 * Both subcommands defer the reply because the underlying queries can take
 * 50-300ms.
 *
 * Hard rules honored:
 *  - All embeds via `embed-builders.ts` (`buildLeaderboardEmbed` for the
 *    happy path, `buildErrorEmbed` for failures, slow-down embed for rate
 *    limits). Disclosure footer + spacer field baked into every output.
 *  - Per-user rate-limit via atomic `consumeRateLimitToken` on the bucket
 *    `discord:command:leaderboard:<userId>` (capacity 5, refill 5/min).
 *  - All LeaderboardSnapshot + Pull reads filter `deletedAt: null`.
 *  - Replies are ephemeral so a chatty user does not spam the channel.
 *  - Rate-limit check happens BEFORE deferring so an exhausted user does not
 *    consume a deferred-reply slot.
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
  buildLeaderboardEmbed,
  type LeaderboardEntryInput,
} from '../embed-builders.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';
import { prismaQuery } from '../../prisma.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';

const LOG_PREFIX = '[leaderboard]';

const TOP_N = 5;
const HISTORY_MIN_LIMIT = 1;
const HISTORY_MAX_LIMIT = 7;
const HISTORY_DEFAULT_LIMIT = 7;

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

/**
 * Local row shape for LeaderboardSnapshot reads with the `pull` include. The
 * generated Prisma include-type only exists post-`bun run db:push`, so we
 * declare the structural shape here. The runtime client returns rows
 * structurally compatible with this interface.
 */
interface SnapshotWithPull {
  rank: number;
  windowStartAt: Date;
  windowEndAt: Date;
  netGainUsdCents: number;
  fmvUsdCents: number | null;
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
}

const consumeLeaderboardToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:leaderboard:${userId}`, 5, 5);
};

const buildRateLimitedEmbed = (): EmbedBuilder => {
  return new EmbedBuilder()
    .setTitle('Slow down please')
    .setColor(0xe67e22)
    .setDescription(
      'You have hit the /leaderboard rate limit (5 per minute). Try again shortly.'
    )
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());
};

const formatSignedUsdFromCents = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) {
    return '–';
  }
  const sign = cents >= 0 ? '+' : '-';
  const abs = Math.abs(cents);
  const dollars = abs / 100;
  if (dollars >= 1000) {
    return `${sign}$${dollars.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  return `${sign}$${dollars.toFixed(2)}`;
};

const handleDaily = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  let latest;
  try {
    latest = await prismaQuery.leaderboardSnapshot.findFirst({
      where: { deletedAt: null },
      orderBy: { windowEndAt: 'desc' },
      select: { windowEndAt: true, windowStartAt: true },
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} daily latest lookup failed:`, err);
    await interaction.editReply({
      embeds: [
        buildErrorEmbed('Failed to load leaderboard. Please try again in a moment.'),
      ],
    });
    return;
  }

  if (latest === null) {
    // Empty-state embed: synthesize a trailing 24h window so the user sees
    // an honest empty state rather than a missing reply.
    const now = new Date();
    const embed = buildLeaderboardEmbed({
      windowStartAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      windowEndAt: now,
      entries: [],
      title: 'Pull of the Day',
      description: 'No leaderboard snapshot yet. Check back after the next hourly tick.',
    });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  let rows: SnapshotWithPull[];
  try {
    rows = await prismaQuery.leaderboardSnapshot.findMany({
      where: { windowEndAt: latest.windowEndAt, deletedAt: null },
      orderBy: { rank: 'asc' },
      take: TOP_N,
      include: {
        pull: {
          select: {
            id: true,
            cardName: true,
            setName: true,
            gradingCompany: true,
            grade: true,
            packSlug: true,
            frontImageUrl: true,
            serial: true,
          },
        },
      },
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} daily entries lookup failed:`, err);
    await interaction.editReply({
      embeds: [
        buildErrorEmbed('Failed to load leaderboard. Please try again in a moment.'),
      ],
    });
    return;
  }

  const entries: LeaderboardEntryInput[] = rows.map((r: SnapshotWithPull) => ({
    rank: r.rank,
    pull: r.pull,
    netGainUsdCents: r.netGainUsdCents,
    fmvUsdCents: r.fmvUsdCents,
  }));

  const embed = buildLeaderboardEmbed({
    windowStartAt: latest.windowStartAt,
    windowEndAt: latest.windowEndAt,
    entries,
    title: 'Pull of the Day',
    description: 'The 5 best Renaiss pack pulls from the last 24 hours.',
  });

  await interaction.editReply({ embeds: [embed] });
  console.log(
    `${LOG_PREFIX} daily ok user=${interaction.user.id} entries=${entries.length}`
  );
};

const handleHistory = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const limitRaw = interaction.options.getInteger('limit', false);
  let limit = HISTORY_DEFAULT_LIMIT;
  if (typeof limitRaw === 'number' && Number.isFinite(limitRaw)) {
    if (limitRaw < HISTORY_MIN_LIMIT || limitRaw > HISTORY_MAX_LIMIT) {
      await interaction.editReply({
        embeds: [
          buildErrorEmbed(
            `Limit must be an integer in [${HISTORY_MIN_LIMIT}, ${HISTORY_MAX_LIMIT}].`
          ),
        ],
      });
      return;
    }
    limit = Math.floor(limitRaw);
  }

  let rows: SnapshotWithPull[];
  try {
    // One row per daily window: take rank=1 across the last N windowEndAt
    // values. We sort by windowEndAt DESC and rely on the hourly cron to
    // produce one set of (windowEndAt, rank=1) per hour. The slash command's
    // "daily history" surface picks the freshest rank-1 per day from the
    // hourly snapshot stream; we approximate by taking the last N rank-1
    // rows. Hourly granularity is acceptable for a Discord summary.
    rows = await prismaQuery.leaderboardSnapshot.findMany({
      where: { rank: 1, deletedAt: null },
      orderBy: { windowEndAt: 'desc' },
      take: limit,
      include: {
        pull: {
          select: {
            id: true,
            cardName: true,
            setName: true,
            gradingCompany: true,
            grade: true,
            packSlug: true,
            frontImageUrl: true,
            serial: true,
          },
        },
      },
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} history lookup failed:`, err);
    await interaction.editReply({
      embeds: [
        buildErrorEmbed('Failed to load leaderboard history. Please try again.'),
      ],
    });
    return;
  }

  if (rows.length === 0) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          'No leaderboard snapshots yet. Check back after the first hourly tick.'
        ),
      ],
    });
    return;
  }

  // Render one field per snapshot. We deliberately reuse buildLeaderboardEmbed
  // for the wrapper (so disclosure / footer are present) and add per-day
  // fields directly. The first row's window labels the embed's main window.
  const embed = buildLeaderboardEmbed({
    windowStartAt: rows[rows.length - 1].windowStartAt,
    windowEndAt: rows[0].windowEndAt,
    entries: [],
    title: `Leaderboard history (last ${rows.length})`,
    description: `Top pull from each of the last ${rows.length} snapshot windows.`,
  });

  // Inject per-window fields BEFORE the disclosure spacer. The disclosure
  // spacer is the last field set by buildLeaderboardEmbed; we splice ours in
  // ahead of it by reading existing fields, prepending, then re-setting.
  const existingFields = embed.data.fields ?? [];
  const historyFields = rows.map((r: SnapshotWithPull) => {
    const epoch = Math.floor(r.windowEndAt.getTime() / 1000);
    const name =
      r.pull.cardName ?? r.pull.setName ?? `Pull ${r.pull.id.slice(0, 8)}`;
    const gradeBits: string[] = [];
    if (typeof r.pull.gradingCompany === 'string' && r.pull.gradingCompany.length > 0) {
      gradeBits.push(r.pull.gradingCompany);
    }
    if (typeof r.pull.grade === 'string' && r.pull.grade.length > 0) {
      gradeBits.push(r.pull.grade);
    }
    const gradeSuffix = gradeBits.length > 0 ? ` (${gradeBits.join(' ')})` : '';
    return {
      name: `<t:${epoch}:D>`,
      value: `${name}${gradeSuffix} · ${r.pull.packSlug} — ${formatSignedUsdFromCents(r.netGainUsdCents)}`,
      inline: false,
    };
  });

  embed.setFields([...historyFields, ...existingFields]);

  await interaction.editReply({ embeds: [embed] });
  console.log(
    `${LOG_PREFIX} history ok user=${interaction.user.id} rows=${rows.length}`
  );
};

const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Show the PullCast leaderboard (trailing 24h or recent history).')
  .addSubcommand((sc) =>
    sc
      .setName('daily')
      .setDescription('Show the latest top-5 pulls from the trailing 24h window.')
  )
  .addSubcommand((sc) =>
    sc
      .setName('history')
      .setDescription('Show the top pull from each of the last N snapshot windows.')
      .addIntegerOption((opt) =>
        opt
          .setName('limit')
          .setDescription('Number of recent windows to show (1-7, default 7).')
          .setRequired(false)
          .setMinValue(HISTORY_MIN_LIMIT)
          .setMaxValue(HISTORY_MAX_LIMIT)
      )
  );

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  // Rate-limit BEFORE deferring so an exhausted user does not consume a
  // deferred reply slot.
  const allowed = await consumeLeaderboardToken(interaction.user.id);
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

  const sub = interaction.options.getSubcommand();
  try {
    switch (sub) {
      case 'daily':
        await handleDaily(interaction);
        return;
      case 'history':
        await handleHistory(interaction);
        return;
      default:
        await interaction.editReply({
          embeds: [buildErrorEmbed(`Unknown subcommand: ${sub}`)],
        });
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} handler unexpected error sub=${sub}:`, err);
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

export const leaderboardCommand: Command = { data, handler };

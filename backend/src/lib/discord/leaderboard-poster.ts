/**
 * Daily "Pull of the Day" digest poster.
 *
 * Called by the leaderboard worker's daily cron (04:00 UTC = 12:00 UTC+8).
 * Given the top-5 leaderboard snapshot rows for the trailing 24h window,
 * fan out a single digest embed to every distinct active Discord channel
 * that has at least one Subscription.
 *
 * Per-channel pipeline mirrors `share-card-poster.postPullToSubscribers`:
 *   1. Resolve the channel via the Discord client.
 *   2. Verify it is text-capable.
 *   3. Consume a token from the SHARED bucket `discord:channel:<id>`
 *      (so one daily post counts against the same budget as auto-share).
 *   4. Send the embed.
 *
 * Single-attempt-per-day: a failed send is NOT retried on the next tick.
 * The next day's digest is the recovery path.
 *
 * Safety rails:
 *  - Channels not text-capable or not found are soft-deleted from
 *    Subscription so we stop trying.
 *  - Errors per-channel are caught; one bad channel never stops the others.
 *  - Disclosure footer + spacer field are baked into the embed builder.
 */

import { DISCORD_POST_RATE_PER_CHANNEL_PER_MIN } from '../../config/main-config.ts';
import { prismaQuery } from '../prisma.ts';
import { consumeRateLimitToken } from '../rate-limit.ts';
import { getDiscordClient } from './client.ts';
import {
  buildLeaderboardEmbed,
  type LeaderboardEntryInput,
} from './embed-builders.ts';

const LOG_PREFIX = '[leaderboard-post]';

export interface LeaderboardPostResult {
  posted: number;
  skipped: number;
  failed: number;
}

/**
 * Compact projection of the joined LeaderboardSnapshot + Pull rows the worker
 * already loads. We keep the shape local to this module to avoid depending on
 * the Prisma generated row type (only available post-`bun run db:push`).
 */
export interface LeaderboardSnapshotWithPull {
  rank: number;
  netGainUsdCents: number;
  fmvUsdCents: number | null;
  windowStartAt: Date;
  windowEndAt: Date;
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

/**
 * Project a snapshot row into the embed-builder shape. The builder owns the
 * formatting and disclosure footer; this poster only owns the fan-out plumbing.
 */
const toEntry = (s: LeaderboardSnapshotWithPull): LeaderboardEntryInput => ({
  rank: s.rank,
  pull: s.pull,
  netGainUsdCents: s.netGainUsdCents,
  fmvUsdCents: s.fmvUsdCents,
});

/**
 * Fan out the daily digest to every distinct active subscription channel.
 *
 * Best-effort: never throws. Returns counters so the worker can log a single
 * summary line per daily slot.
 */
export const postDailyLeaderboardToSubscribers = async (
  snapshotEntries: LeaderboardSnapshotWithPull[]
): Promise<LeaderboardPostResult> => {
  const counters: LeaderboardPostResult = { posted: 0, skipped: 0, failed: 0 };

  if (!Array.isArray(snapshotEntries) || snapshotEntries.length === 0) {
    console.log(`${LOG_PREFIX} no snapshot entries to post`);
    return counters;
  }

  // Window labels come from the first row (all entries in a single batch share
  // the same window). If the window timestamps differ we still trust row[0]
  // since the worker writes them inside one transaction.
  const windowStartAt = snapshotEntries[0].windowStartAt;
  const windowEndAt = snapshotEntries[0].windowEndAt;

  // Distinct active channel ids. We collapse multiple subscriptions in the
  // same channel into a single post so a channel with 20 wallet-scoped subs
  // does not receive 20 copies of the daily digest.
  let channelRows: Array<{ discordChannelId: string }>;
  try {
    channelRows = await prismaQuery.subscription.findMany({
      where: { deletedAt: null },
      select: { discordChannelId: true },
      distinct: ['discordChannelId'],
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to load distinct channels:`, err);
    return counters;
  }

  if (channelRows.length === 0) {
    console.log(`${LOG_PREFIX} no active subscription channels`);
    return counters;
  }

  // Build the embed ONCE. Re-use across every channel send.
  const embed = buildLeaderboardEmbed({
    windowStartAt,
    windowEndAt,
    entries: snapshotEntries.slice(0, 5).map(toEntry),
    title: 'Pull of the Day',
    description: 'The 5 best Renaiss pack pulls from the last 24 hours.',
  });

  const client = getDiscordClient();
  if (!client.isReady()) {
    console.warn(
      `${LOG_PREFIX} discord client not ready, skipping daily fanout (${channelRows.length} channels)`
    );
    counters.skipped = channelRows.length;
    return counters;
  }

  const isoWindowEnd = windowEndAt.toISOString();

  for (const row of channelRows) {
    const channelId = row.discordChannelId;
    if (typeof channelId !== 'string' || channelId.length === 0) {
      counters.skipped += 1;
      continue;
    }

    try {
      // 1. Resolve channel BEFORE consuming a rate-limit token so dead
      //    channels do not waste tokens. Same order as share-card-poster.
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel === null) {
        console.warn(
          `${LOG_PREFIX} channel not found, soft-deleting subscriptions channel=${channelId}`
        );
        await prismaQuery.subscription
          .updateMany({
            where: { discordChannelId: channelId, deletedAt: null },
            data: { deletedAt: new Date() },
          })
          .catch((e: unknown) =>
            console.error(
              `${LOG_PREFIX} soft-delete failed channel=${channelId}:`,
              e
            )
          );
        counters.skipped += 1;
        continue;
      }
      if (
        !('send' in channel) ||
        typeof channel.send !== 'function' ||
        !channel.isTextBased()
      ) {
        console.warn(
          `${LOG_PREFIX} channel not text-capable, soft-deleting subscriptions channel=${channelId}`
        );
        await prismaQuery.subscription
          .updateMany({
            where: { discordChannelId: channelId, deletedAt: null },
            data: { deletedAt: new Date() },
          })
          .catch((e: unknown) =>
            console.error(
              `${LOG_PREFIX} soft-delete failed channel=${channelId}:`,
              e
            )
          );
        counters.skipped += 1;
        continue;
      }

      // 2. Consume token from the SHARED auto-share bucket so the daily digest
      //    counts against the same per-channel budget. One bot, one budget.
      const allowed = await consumeRateLimitToken(
        `discord:channel:${channelId}`,
        DISCORD_POST_RATE_PER_CHANNEL_PER_MIN,
        DISCORD_POST_RATE_PER_CHANNEL_PER_MIN
      );
      if (!allowed) {
        console.warn(
          `${LOG_PREFIX} rate-limited channel=${channelId} windowEnd=${isoWindowEnd}`
        );
        counters.skipped += 1;
        continue;
      }

      // 3. Send. No file attachment; the embed thumbnail is set by the builder
      //    when the rank-1 imageUrl passes the SSRF allowlist.
      await channel.send({ embeds: [embed] });

      console.log(
        `${LOG_PREFIX} sent channel=${channelId} windowEnd=${isoWindowEnd}`
      );
      counters.posted += 1;
    } catch (err) {
      console.error(
        `${LOG_PREFIX} send failed channel=${channelId} windowEnd=${isoWindowEnd}:`,
        err
      );
      counters.failed += 1;
    }
  }

  console.log(
    `${LOG_PREFIX} daily fanout done posted=${counters.posted} skipped=${counters.skipped} failed=${counters.failed} windowEnd=${isoWindowEnd}`
  );

  return counters;
};

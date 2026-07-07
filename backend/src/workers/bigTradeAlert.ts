/**
 * Big Trade Alert cron worker (D8, second passive-engagement surface).
 *
 * Fires every 5 minutes. On tick:
 *
 *   1. Fetch `renaissIndex.getRecentTrades({ limit: BIG_TRADE_POLL_LIMIT })`.
 *   2. Filter by kind='transaction' AND priceUsdCents >= threshold (default
 *      BIG_TRADE_USD_CENTS_DEFAULT; per-channel overrides possible via
 *      Subscription.metadata.threshold_usd_cents).
 *   3. Dedupe against a persisted cursor row (Cursor.packSlug =
 *      BIG_TRADE_CURSOR_SLUG, Cursor.lastSeenTimestamp = newest observedAt
 *      previously alerted). Only trades strictly newer than the cursor advance.
 *   4. For each subscribed channel (Subscription.type = 'BIG_TRADE_ALERT'):
 *      - Determine the effective threshold (channel override or default).
 *      - Re-filter the qualifying set for that specific channel.
 *      - If <= BIG_TRADE_BATCH_THRESHOLD trades qualify: send one embed per
 *        trade (rate-limited via `consumeRateLimitToken`).
 *      - If > BIG_TRADE_BATCH_THRESHOLD: send one digest embed instead.
 *   5. Advance the cursor to the newest observedAt seen (across the whole poll,
 *      not per-channel) so the next tick does not re-alert the same trades.
 *
 * Cost model (per 17_renaiss_cli_indexapi_research.md Section 4):
 *   - Public tier documented at ~60/min and ~1,000/day per IP.
 *   - This worker: 288 upstream requests/day (one every 5 min).
 *   - Well under both ceilings; leaves headroom for cache-miss traffic.
 *
 * Rules honored:
 *   - `isRunning` flag guard + wall-clock timeout wrapper.
 *   - `timezone: 'Asia/Hong_Kong'` on the cron.schedule.
 *   - No boot-time execution (only the schedule fires) so a restart mid-day
 *     does not re-emit alerts for the current cursor window.
 *   - Discord 403 / channel-not-found -> soft-delete the offending
 *     Subscription (defense in depth; matches share-card-poster pattern).
 *   - Never touches /web. Never runs Prisma destructive commands.
 */

import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';

import { prismaQuery } from '../lib/prisma.ts';
import { getDiscordClient } from '../lib/discord/client.ts';
import {
  renaissIndex,
  IndexApiError,
  hasIndexPartnerAuth,
} from '../lib/renaiss-index/index.ts';
import type { IndexTrade } from '../lib/renaiss-index/index.ts';
import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import {
  DISCORD_POST_RATE_PER_CHANNEL_PER_MIN,
  BIG_TRADE_USD_CENTS_DEFAULT,
  BIG_TRADE_POLL_LIMIT,
  BIG_TRADE_BATCH_THRESHOLD,
  BIG_TRADE_CURSOR_SLUG,
} from '../config/main-config.ts';
import {
  filterQualifyingTrades,
  newestObservedAtMs,
  buildBigTradeAlertEmbed,
  buildBigTradeDigestEmbed,
  parseChannelThresholdCents,
  type QualifyingTrade,
} from './bigTradeAlert.filters.ts';

const LOG_PREFIX = '[BigTradeAlert]';

const CRON_SCHEDULE = '*/5 * * * *' as const;
const CRON_TIMEZONE = 'Asia/Hong_Kong' as const;
const TICK_TIMEOUT_MS = 30_000;

let isRunning = false;

const withTimeout = async <T>(p: Promise<T>, ms: number, tag: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${LOG_PREFIX} ${tag} exceeded ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};

/**
 * Load the persisted cursor row for this worker. Returns the last-seen
 * observedAt in epoch ms, or null when the worker has never run before (so
 * the first tick considers every returned trade above threshold "new").
 */
export const loadCursorMs = async (): Promise<number | null> => {
  try {
    const row = await prismaQuery.cursor.findFirst({
      where: { packSlug: BIG_TRADE_CURSOR_SLUG, deletedAt: null },
      select: { lastSeenTimestamp: true },
    });
    if (row === null || row.lastSeenTimestamp === null) return null;
    return row.lastSeenTimestamp.getTime();
  } catch (err) {
    console.warn(`${LOG_PREFIX} cursor load failed, treating as empty:`, err);
    return null;
  }
};

/**
 * Advance the cursor to `newMs` iff it moves forward. Uses upsert so the first
 * run creates the row.
 */
export const advanceCursor = async (newMs: number): Promise<void> => {
  const newDate = new Date(newMs);
  try {
    await prismaQuery.cursor.upsert({
      where: { packSlug: BIG_TRADE_CURSOR_SLUG },
      create: {
        packSlug: BIG_TRADE_CURSOR_SLUG,
        lastSeenTimestamp: newDate,
        lastSuccessfulPollAt: new Date(),
      },
      update: {
        lastSeenTimestamp: newDate,
        lastSuccessfulPollAt: new Date(),
        consecutiveFailures: 0,
      },
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} cursor advance failed newMs=${newMs}:`, err);
  }
};

interface SubscriptionRow {
  id: string;
  discordChannelId: string;
  metadata: string | null;
}

const loadAlertSubscriptions = async (): Promise<SubscriptionRow[]> => {
  const rows = await prismaQuery.subscription.findMany({
    where: { deletedAt: null, type: 'BIG_TRADE_ALERT' },
    select: { id: true, discordChannelId: true, metadata: true },
  });
  return rows;
};

const softDeleteSubscriptionsForChannel = async (channelId: string): Promise<void> => {
  await prismaQuery.subscription
    .updateMany({
      where: {
        discordChannelId: channelId,
        type: 'BIG_TRADE_ALERT',
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    })
    .catch((e: unknown) =>
      console.error(`${LOG_PREFIX} soft-delete failed channel=${channelId}:`, e)
    );
};

interface SendOutcome {
  posted: number;
  skipped: number;
  failed: number;
}

/**
 * Send a set of embeds to a single Discord channel. Rate-limited per-channel
 * via the atomic token bucket. Soft-deletes the subscription row if the
 * channel is unreachable / non-text (defense in depth).
 */
const sendToChannel = async (
  channelId: string,
  embeds: EmbedBuilder[]
): Promise<SendOutcome> => {
  const outcome: SendOutcome = { posted: 0, skipped: 0, failed: 0 };

  const client = getDiscordClient();
  if (!client.isReady()) {
    console.warn(`${LOG_PREFIX} discord not ready, skipping channel=${channelId}`);
    outcome.skipped += embeds.length;
    return outcome;
  }

  let channel;
  try {
    channel = await client.channels.fetch(channelId).catch(() => null);
  } catch (err) {
    console.error(`${LOG_PREFIX} channel fetch threw channel=${channelId}:`, err);
    outcome.failed += embeds.length;
    return outcome;
  }

  if (
    channel === null ||
    !('send' in channel) ||
    typeof channel.send !== 'function' ||
    !channel.isTextBased()
  ) {
    console.warn(
      `${LOG_PREFIX} channel not usable, soft-deleting subs channel=${channelId}`
    );
    await softDeleteSubscriptionsForChannel(channelId);
    outcome.skipped += embeds.length;
    return outcome;
  }

  for (const embed of embeds) {
    const allowed = await consumeRateLimitToken(
      `discord:channel:${channelId}`,
      DISCORD_POST_RATE_PER_CHANNEL_PER_MIN,
      DISCORD_POST_RATE_PER_CHANNEL_PER_MIN
    );
    if (!allowed) {
      console.warn(`${LOG_PREFIX} rate-limited channel=${channelId}`);
      outcome.skipped += 1;
      continue;
    }

    try {
      await channel.send({ embeds: [embed] });
      outcome.posted += 1;
    } catch (err) {
      // Discord 403 = missing send permission or bot removed from channel.
      // Match discord.js's DiscordAPIError shape without importing the type.
      const status = (err as { status?: unknown })?.status;
      if (status === 403 || status === 404) {
        console.warn(
          `${LOG_PREFIX} discord ${status} on channel=${channelId}, soft-deleting subs`
        );
        await softDeleteSubscriptionsForChannel(channelId);
        outcome.skipped += 1;
      } else {
        console.error(`${LOG_PREFIX} send failed channel=${channelId}:`, err);
        outcome.failed += 1;
      }
    }
  }
  return outcome;
};

/**
 * Per-channel fanout. Applies channel-level threshold override, decides
 * digest-vs-individual, calls sendToChannel.
 */
const fanoutToChannel = async (
  sub: SubscriptionRow,
  qualifyingGlobal: QualifyingTrade[]
): Promise<SendOutcome> => {
  const channelThreshold =
    parseChannelThresholdCents(sub.metadata) ?? BIG_TRADE_USD_CENTS_DEFAULT;

  // Re-filter for this channel's threshold (may be stricter than the global).
  const forChannel = qualifyingGlobal.filter(
    (q) => q.priceUsdCents >= channelThreshold
  );

  if (forChannel.length === 0) {
    return { posted: 0, skipped: 0, failed: 0 };
  }

  if (forChannel.length > BIG_TRADE_BATCH_THRESHOLD) {
    const digest = buildBigTradeDigestEmbed({
      qualifying: forChannel,
      totalCount: forChannel.length,
    });
    return sendToChannel(sub.discordChannelId, [digest]);
  }

  const embeds = forChannel.map((q) => buildBigTradeAlertEmbed({ qualifying: q }));
  return sendToChannel(sub.discordChannelId, embeds);
};

/**
 * One tick of the worker. Exported for tests / manual triggers.
 */
export const runOnce = async (): Promise<void> => {
  // Public tier is 10 requests / day per IP. A 5-min cron would burn that in
  // under an hour. Skip the tick entirely when partner credentials are not
  // configured so we don't destroy the user-facing quota. Log once per tick so
  // ops still sees the worker is scheduled.
  if (!hasIndexPartnerAuth()) {
    console.log(`${LOG_PREFIX} tick skipped: no partner API credentials`);
    return;
  }

  console.log(`${LOG_PREFIX} tick start`);

  let trades: IndexTrade[];
  try {
    trades = await renaissIndex.getRecentTrades({ limit: BIG_TRADE_POLL_LIMIT });
  } catch (err) {
    if (err instanceof IndexApiError) {
      console.warn(
        `${LOG_PREFIX} recent trades fetch failed status=${err.status ?? 'null'}, aborting tick`
      );
    } else {
      console.error(`${LOG_PREFIX} recent trades fetch unexpected error:`, err);
    }
    return;
  }

  if (trades.length === 0) {
    console.log(`${LOG_PREFIX} no trades returned, nothing to do`);
    return;
  }

  const cursorMs = await loadCursorMs();

  // Filter using the DEFAULT threshold. Per-channel overrides re-filter down
  // to a stricter bar, so the global set is always the superset of what any
  // channel will receive. This keeps one embed render call per unique trade.
  const qualifying = filterQualifyingTrades({
    trades,
    thresholdCents: BIG_TRADE_USD_CENTS_DEFAULT,
    cursorMs,
  });

  if (qualifying.length === 0) {
    console.log(
      `${LOG_PREFIX} tick done posted=0 skipped=0 failed=0 fetched=${trades.length} qualifying=0 cursor=${cursorMs ?? 'none'}`
    );
    return;
  }

  const subs = await loadAlertSubscriptions().catch((err: unknown) => {
    console.error(`${LOG_PREFIX} subs load failed:`, err);
    return [] as SubscriptionRow[];
  });

  let posted = 0;
  let skipped = 0;
  let failed = 0;

  for (const sub of subs) {
    const outcome = await fanoutToChannel(sub, qualifying);
    posted += outcome.posted;
    skipped += outcome.skipped;
    failed += outcome.failed;
  }

  // Advance the cursor to the newest observedAt across the qualifying set,
  // regardless of whether any channel actually posted. Fanout failures should
  // not cause the same trade to re-alert next tick and spam every subscriber.
  const newestMs = newestObservedAtMs(qualifying);
  if (newestMs !== null) {
    await advanceCursor(newestMs);
  }

  console.log(
    `${LOG_PREFIX} tick done posted=${posted} skipped=${skipped} failed=${failed} fetched=${trades.length} qualifying=${qualifying.length} subs=${subs.length} newest_observed_at=${newestMs !== null ? new Date(newestMs).toISOString() : 'null'}`
  );
};

const tick = async (): Promise<void> => {
  if (isRunning) {
    console.log(`${LOG_PREFIX} previous tick still running, skipping`);
    return;
  }
  isRunning = true;
  try {
    await withTimeout(runOnce(), TICK_TIMEOUT_MS, 'runOnce');
  } catch (err) {
    console.error(`${LOG_PREFIX} tick failed:`, err);
  } finally {
    isRunning = false;
  }
};

export const startBigTradeAlertWorker = (): void => {
  console.log(
    `${LOG_PREFIX} Scheduled schedule="${CRON_SCHEDULE}" tz=${CRON_TIMEZONE} threshold_usd_cents=${BIG_TRADE_USD_CENTS_DEFAULT}`
  );
  cron.schedule(
    CRON_SCHEDULE,
    () => {
      void tick();
    },
    { timezone: CRON_TIMEZONE }
  );
};

// Exported for tests / manual triggers.
export const _tickForTest = tick;

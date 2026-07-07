/**
 * Leaderboard worker.
 *
 * Two crons:
 *
 *   1. Hourly snapshot (`5 * * * *`): Computes the trailing 24h top-5 every
 *      hour at minute 5 and upserts LeaderboardSnapshot rows. The 5-minute
 *      offset gives the indexer + cert-bridge a buffer before we read.
 *
 *   2. Daily digest fanout (`0 4 * * *`): At 04:00 UTC (= 12:00 UTC+8) each
 *      day, take the latest snapshot batch and fan a "Pull of the Day" embed
 *      out to every distinct active subscription channel via
 *      `postDailyLeaderboardToSubscribers`.
 *
 * Algorithm per hourly tick:
 *   1. windowEnd = now (UTC).
 *      windowStart = now - 24h.
 *   2. Load the active OptOut set so we can exclude buyer wallets from the
 *      ranking at compute time (so the snapshot never lists an opted-out
 *      wallet's pulls, even retroactively).
 *   3. Top 5 Pulls by netGainUsdCents in [windowStart, windowEnd], soft-delete
 *      filtered, netGainUsdCents non-null, buyerAddress NOT IN opt-out set.
 *   4. In a transaction: upsert each into LeaderboardSnapshot on the composite
 *      unique (windowEndAt, rank). Empty update body so a re-run for the same
 *      windowEnd is a no-op (idempotent retry).
 *   5. Soft-delete LeaderboardSnapshot rows older than 30 days
 *      (deletedAt = now WHERE windowEndAt < cutoff AND deletedAt = null).
 *
 * Algorithm per daily-digest tick:
 *   1. Load the latest LeaderboardSnapshot batch (rank 1..5 for the most
 *      recent windowEndAt).
 *   2. Hand off to `postDailyLeaderboardToSubscribers`, which handles
 *      channel resolution, capability checks, rate-limit consumption, and
 *      send. Single attempt per channel per daily slot.
 *
 * Hard rules honored:
 *   - All queries filter `deletedAt: null`.
 *   - Worker NEVER blocks the cron tick; both ticks are wrapped in a 30s
 *     `Promise.race` timeout so a slow query / Discord stall does not pile
 *     up overlapping ticks.
 *   - Separate `isRunning` flags for hourly snapshot vs daily-post so a slow
 *     fanout never blocks the hourly leaderboard.
 *   - Daily-post does NOT fire on boot (only on schedule). Hourly snapshot
 *     still pre-computes 10s after boot so /api/leaderboard/daily has data
 *     for the demo even before the first hourly tick.
 *   - No `any`. No `process.env.X` reads. Logs prefixed `[leaderboard]` for
 *     compute and `[leaderboard-post]` (from the poster module) for fanout.
 */

import cron from 'node-cron';

import { prismaQuery } from '../lib/prisma.ts';
import {
  postDailyLeaderboardToSubscribers,
  type LeaderboardSnapshotWithPull,
} from '../lib/discord/leaderboard-poster.ts';

const LOG_PREFIX = '[leaderboard]';

const HOURLY_CRON_SCHEDULE = '5 * * * *' as const;
// 04:00 UTC = 12:00 UTC+8. The daily digest fires once per day in Asia noon.
const DAILY_POST_CRON_SCHEDULE = '0 4 * * *' as const;
const BOOT_DELAY_MS = 10_000;
const TOP_N = 5;
const TICK_TIMEOUT_MS = 30_000;
const DAILY_POST_TIMEOUT_MS = 60_000;
const SOFT_DELETE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let isHourlyRunning = false;
let isDailyPostRunning = false;

interface TopPullRow {
  id: string;
  packSlug: string;
  netGainUsdCents: number | null;
  fmvUsdCents: number | null;
}

/**
 * Run a function with a wall-clock timeout. Throws a tagged error if the
 * timeout fires; the calling tick treats that as a recoverable failure and
 * waits for the next cron tick.
 */
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
 * Compute one leaderboard snapshot for the trailing 24h window and persist
 * the result. Idempotent on (windowEndAt, rank): a re-run for the same window
 * end is a no-op.
 */
const computeSnapshot = async (): Promise<void> => {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);

  // Compute-time OptOut filter. The indexer also skips opted-out wallets at
  // ingest time, but defense-in-depth: if a wallet opts out AFTER its pulls
  // were already persisted (e.g. via the new /pullcast optout slash command),
  // we still want subsequent leaderboards to exclude them. Pulling the active
  // opt-out set once and using `notIn` is one query, not N.
  let optedOutWallets: string[] = [];
  try {
    const optOutRows = await prismaQuery.optOut.findMany({
      where: { deletedAt: null },
      select: { walletAddress: true },
    });
    optedOutWallets = optOutRows
      .map((r: { walletAddress: string }) => r.walletAddress)
      .filter((w: string) => typeof w === 'string' && w.length > 0);
  } catch (err) {
    // OptOut lookup failure is not fatal; we surface and continue with an
    // empty opt-out set so the leaderboard still ranks. The indexer is the
    // primary opt-out guard; this is the secondary.
    console.warn(`${LOG_PREFIX} OptOut load failed, proceeding without filter:`, err);
  }

  // Top 5 by netGainUsdCents. We filter `netGainUsdCents: { not: null }` so
  // pulls with unknown FMV (cert bridge still in flight) do not pollute the
  // ranking with NULLs (which Postgres treats as smallest under ORDER BY DESC
  // anyway, but explicit is better than implicit). Exclude opted-out wallets.
  const top: TopPullRow[] = await prismaQuery.pull.findMany({
    where: {
      pulledAtTimestamp: { gte: windowStart, lte: windowEnd },
      netGainUsdCents: { not: null },
      deletedAt: null,
      ...(optedOutWallets.length > 0
        ? { buyerAddress: { notIn: optedOutWallets } }
        : {}),
    },
    orderBy: { netGainUsdCents: 'desc' },
    take: TOP_N,
    select: {
      id: true,
      packSlug: true,
      netGainUsdCents: true,
      fmvUsdCents: true,
    },
  });

  if (top.length === 0) {
    console.log(
      `${LOG_PREFIX} computed window=${windowEnd.toISOString()} top=0 (no qualifying pulls)`
    );
    // Still run the retention pass so the table does not accumulate
    // indefinitely during early-days low-data periods.
    await pruneOldSnapshots();
    return;
  }

  // Single transaction so a partial failure mid-rank does not leave a stale
  // mixed-window snapshot in the live table. We use the array form of
  // `$transaction` (PrismaPromise[]) so we don't need to type the interactive
  // `TransactionClient` callback parameter, which depends on the generated
  // client (only materializes after `bun run db:push`).
  const upsertOps = top
    .map((row, i) => {
      const rank = i + 1;
      const netGain = row.netGainUsdCents;
      if (netGain === null) {
        // Defensive; the where clause already excludes nulls but the type is
        // still `number | null` in the select.
        return null;
      }
      return prismaQuery.leaderboardSnapshot.upsert({
        where: {
          windowEndAt_rank: {
            windowEndAt: windowEnd,
            rank,
          },
        },
        create: {
          windowStartAt: windowStart,
          windowEndAt: windowEnd,
          rank,
          pullId: row.id,
          netGainUsdCents: netGain,
          fmvUsdCents: row.fmvUsdCents,
          packSlug: row.packSlug,
        },
        // Empty update body: idempotent re-run, do not mutate an existing row.
        // First-write-wins for a given (windowEndAt, rank) tuple.
        update: {},
      });
    })
    .filter(<T>(v: T | null): v is T => v !== null);

  if (upsertOps.length > 0) {
    // L-11: SET LOCAL statement_timeout inside the same transaction as the
    // upserts. Bounds Postgres-side wall time so a slow query cannot tie up
    // the connection beyond the worker's intent. Only applies for the
    // duration of this transaction; falls off automatically at COMMIT.
    await prismaQuery.$transaction([
      prismaQuery.$executeRaw`SET LOCAL statement_timeout = '25s'`,
      ...upsertOps,
    ]);
  }

  console.log(
    `${LOG_PREFIX} computed window=${windowEnd.toISOString()} top=${top.length}`
  );

  await pruneOldSnapshots();
};

/**
 * Soft-delete LeaderboardSnapshot rows older than 30 days. Keeps the live
 * table small so the /history query stays fast. Soft-delete (not DELETE)
 * because house rule: never hard-delete user-facing records.
 */
const pruneOldSnapshots = async (): Promise<void> => {
  const cutoff = new Date(Date.now() - SOFT_DELETE_AGE_MS);
  try {
    const result = await prismaQuery.leaderboardSnapshot.updateMany({
      where: {
        windowEndAt: { lt: cutoff },
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    if (result.count > 0) {
      console.log(`${LOG_PREFIX} soft-deleted ${result.count} snapshots older than 30d`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} prune failed:`, err);
  }
};

const hourlyTick = async (): Promise<void> => {
  if (isHourlyRunning) {
    console.log(`${LOG_PREFIX} previous hourly tick still running, skipping`);
    return;
  }
  isHourlyRunning = true;
  try {
    await withTimeout(computeSnapshot(), TICK_TIMEOUT_MS, 'computeSnapshot');
  } catch (err) {
    // Single tick failed; next cron fires in <= 1h. Log full error.
    console.error(`${LOG_PREFIX} hourly tick failed:`, err);
  } finally {
    isHourlyRunning = false;
  }
};

/**
 * Daily-digest tick. Loads the latest LeaderboardSnapshot batch (rank 1..5
 * for the most recent windowEndAt, joined with Pull) and hands it to the
 * Discord poster. Single attempt per channel; failures are NOT retried on the
 * next tick (the next day's cron is the recovery path).
 */
const dailyPostTick = async (): Promise<void> => {
  if (isDailyPostRunning) {
    console.log(`${LOG_PREFIX} previous daily-post tick still running, skipping`);
    return;
  }
  isDailyPostRunning = true;
  try {
    await withTimeout(
      (async (): Promise<void> => {
        // Find the latest windowEndAt that has snapshot rows. Mirrors
        // /api/leaderboard/daily so the digest matches the REST surface.
        const latest = await prismaQuery.leaderboardSnapshot.findFirst({
          where: { deletedAt: null },
          orderBy: { windowEndAt: 'desc' },
          select: { windowEndAt: true },
        });

        if (latest === null) {
          console.log(`${LOG_PREFIX} daily-post no snapshot yet, skipping fanout`);
          return;
        }

        const rows = await prismaQuery.leaderboardSnapshot.findMany({
          where: {
            windowEndAt: latest.windowEndAt,
            deletedAt: null,
          },
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

        if (rows.length === 0) {
          console.log(
            `${LOG_PREFIX} daily-post latest snapshot batch empty, skipping fanout`
          );
          return;
        }

        // Cast through the structural shape declared by the poster module.
        // Prisma's generated include-type is unavailable pre-db:push, so we
        // pre-shape the projection above to match LeaderboardSnapshotWithPull.
        const entries: LeaderboardSnapshotWithPull[] = rows.map(
          (s: LeaderboardSnapshotWithPull) => ({
            rank: s.rank,
            netGainUsdCents: s.netGainUsdCents,
            fmvUsdCents: s.fmvUsdCents,
            windowStartAt: s.windowStartAt,
            windowEndAt: s.windowEndAt,
            pull: s.pull,
          })
        );

        await postDailyLeaderboardToSubscribers(entries);
      })(),
      DAILY_POST_TIMEOUT_MS,
      'dailyPost'
    );
  } catch (err) {
    // Single-attempt-per-day. Next cron is tomorrow; log + move on.
    console.error(`${LOG_PREFIX} daily-post tick failed:`, err);
  } finally {
    isDailyPostRunning = false;
  }
};

export const startLeaderboardWorker = (): void => {
  console.log(
    `${LOG_PREFIX} scheduled hourly=${HOURLY_CRON_SCHEDULE} dailyPost=${DAILY_POST_CRON_SCHEDULE} bootDelayMs=${BOOT_DELAY_MS}`
  );

  cron.schedule(HOURLY_CRON_SCHEDULE, () => {
    void hourlyTick();
  });

  cron.schedule(DAILY_POST_CRON_SCHEDULE, () => {
    void dailyPostTick();
  });

  // Hourly snapshot pre-computes 10s after boot so /api/leaderboard/daily has
  // data immediately, without contending with the indexer/Discord boot path.
  // The daily fanout does NOT fire on boot - only on the 04:00 UTC schedule -
  // so a bot restart in the middle of the day does not double-post the digest.
  setTimeout(() => {
    void hourlyTick();
  }, BOOT_DELAY_MS);
};

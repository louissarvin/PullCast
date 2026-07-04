import { prismaQuery } from '../prisma.ts';
import { INDEX_API_DAILY_BUDGET } from '../../config/main-config.ts';
import { IndexApiBudgetError } from './errors.ts';

const LOG_PREFIX = '[renaiss-index]';

/**
 * In-memory counter resets at UTC midnight. The RateLimitBucket row is a
 * crash-safe backup so a restart inside the same UTC day does not reset
 * spending to zero.
 *
 * Bucket key: `index-api:daily:<YYYYMMDD>`.
 */
interface DayState {
  yyyymmdd: string;
  count: number;
  hydrated: boolean;
}

const today = (): string => {
  const now = new Date();
  const y = now.getUTCFullYear().toString().padStart(4, '0');
  const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = now.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${d}`;
};

const state: DayState = { yyyymmdd: today(), count: 0, hydrated: false };

const bucketKeyFor = (yyyymmdd: string): string => `index-api:daily:${yyyymmdd}`;

const hydrateFromDb = async (): Promise<void> => {
  if (state.hydrated) return;
  try {
    const row = await prismaQuery.rateLimitBucket.findUnique({
      where: { bucketKey: bucketKeyFor(state.yyyymmdd) },
    });
    if (row) {
      const used = Math.max(0, row.capacity - row.tokensRemaining);
      state.count = used;
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} budget hydrate failed (continuing in-memory only):`, err);
  } finally {
    state.hydrated = true;
  }
};

const persistAsync = (yyyymmdd: string, count: number): void => {
  const capacity = INDEX_API_DAILY_BUDGET;
  const tokensRemaining = Math.max(0, capacity - count);
  prismaQuery.rateLimitBucket
    .upsert({
      where: { bucketKey: bucketKeyFor(yyyymmdd) },
      create: {
        bucketKey: bucketKeyFor(yyyymmdd),
        tokensRemaining,
        capacity,
        refillPerMinute: 0,
        lastRefillAt: new Date(),
      },
      update: {
        tokensRemaining,
        capacity,
        lastRefillAt: new Date(),
      },
    })
    .catch((err: unknown) => {
      // Never block a request on a bookkeeping write failure.
      console.warn(`${LOG_PREFIX} budget persist failed:`, err);
    });
};

const rolloverIfNeeded = (): void => {
  const t = today();
  if (t !== state.yyyymmdd) {
    state.yyyymmdd = t;
    state.count = 0;
    state.hydrated = false;
  }
};

/**
 * Throws `IndexApiBudgetError` if today's call count is at or above the daily
 * budget. Increments the counter on success.
 *
 * Call this immediately BEFORE every paid Index API request (not from inside
 * cached reads).
 */
export const assertDailyBudget = async (): Promise<void> => {
  rolloverIfNeeded();
  await hydrateFromDb();

  if (state.count >= INDEX_API_DAILY_BUDGET) {
    throw new IndexApiBudgetError(
      `Index API daily budget exhausted (used ${state.count}/${INDEX_API_DAILY_BUDGET})`
    );
  }
  state.count += 1;
  persistAsync(state.yyyymmdd, state.count);
};

/**
 * Diagnostics helper for /healthz or admin endpoints. Does not mutate state.
 */
export const getDailyBudgetStatus = async (): Promise<{
  used: number;
  capacity: number;
  remaining: number;
  yyyymmdd: string;
}> => {
  rolloverIfNeeded();
  await hydrateFromDb();
  return {
    used: state.count,
    capacity: INDEX_API_DAILY_BUDGET,
    remaining: Math.max(0, INDEX_API_DAILY_BUDGET - state.count),
    yyyymmdd: state.yyyymmdd,
  };
};

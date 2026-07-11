/**
 * Shared odds-stats computation. Consumed by both:
 *  - `src/lib/discord/commands/odds.ts` (slash command)
 *  - `src/routes/oddsRoutes.ts`         (REST surface)
 *
 * Stats are computed over the trailing 90 days of Pull rows for a single pack
 * slug. Soft-deleted rows are excluded. Pulls with `netGainUsdCents = null`
 * are excluded from numeric aggregates (mean, median, win rate, top5) because
 * netGain depends on FMV which may be in-flight via the cert bridge. They
 * still count toward the by-tier breakdown only when `tier` and `netGain` are
 * both present (otherwise the breakdown is meaningless).
 *
 * Hard rules:
 *  - All queries filter `deletedAt: null`.
 *  - No `any`. No `process.env.X` reads.
 *  - The caller decides whether to surface stats to the user; `MIN_SAMPLE`
 *    is exposed as a constant so the slash command + REST route can both
 *    short-circuit on small samples without each redefining the threshold.
 */

import { prismaQuery } from '../prisma.ts';

export const ODDS_WINDOW_DAYS = 90;
export const ODDS_MIN_SAMPLE = 10;

import {
  computeTierFrequency,
  computeDivergence,
} from './tier-frequency.ts';
import type {
  TierFrequencyEntry,
  DivergenceEntry,
} from './tier-frequency.ts';

// Re-export the pure kernels from the dedicated file. Split so unit tests
// can exercise the kernels without importing Prisma at module load.
export { computeTierFrequency, computeDivergence };
export type { TierFrequencyEntry, DivergenceEntry };

/**
 * Fetch tier frequencies for the empirical-90d window straight from Prisma.
 * Zero DB cost beyond the existing indexed lookup on (packSlug, pulledAtTs).
 * Returns null when the pack has zero pulls in-window (caller renders a
 * "no data yet" block).
 */
export const computeEmpiricalTierFrequency = async (
  packSlug: string
): Promise<{ total: number; entries: TierFrequencyEntry[] }> => {
  const now = new Date();
  const cutoff = new Date(now.getTime() - ODDS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows: Array<{ tier: string | null }> = await prismaQuery.pull.findMany({
    where: {
      packSlug,
      pulledAtTimestamp: { gte: cutoff },
      deletedAt: null,
    },
    select: { tier: true },
  });
  return computeTierFrequency(rows.map((r: { tier: string | null }) => r.tier));
};

export interface OddsTierBucket {
  count: number;
  avgNetGain: number;
}

export interface OddsTopEntry {
  netGainUsdCents: number;
  tier: string | null;
  gradingCompany: string | null;
  grade: string | null;
}

export interface OddsStats {
  packSlug: string;
  windowDays: number;
  windowStartAt: Date;
  windowEndAt: Date;
  totalPulls: number;          // pulls with non-null netGain in window
  meanNetGainUsdCents: number; // 0 if totalPulls === 0
  medianNetGainUsdCents: number;
  winRate: number;             // pulls with netGain > 0 / totalPulls
  top5: OddsTopEntry[];
  byTier: Record<string, OddsTierBucket>;
}

interface PullRow {
  fmvUsdCents: number | null;
  packPriceUsdCents: number;
  netGainUsdCents: number | null;
  tier: string | null;
  gradingCompany: string | null;
  grade: string | null;
}

const computeMedian = (sortedAsc: number[]): number => {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return sortedAsc[(n - 1) / 2];
  const mid = n / 2;
  return Math.round((sortedAsc[mid - 1] + sortedAsc[mid]) / 2);
};

/**
 * Compute odds stats for `packSlug` over the trailing 90 days.
 *
 * Returns `null` only if the database lookup fails outright; an empty pack
 * (no pulls in window) returns a stats object with totalPulls=0 and zero
 * aggregates so the caller can render an honest "not enough data" embed.
 */
export const computeOddsStats = async (packSlug: string): Promise<OddsStats> => {
  const now = new Date();
  const cutoff = new Date(now.getTime() - ODDS_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const pulls: PullRow[] = await prismaQuery.pull.findMany({
    where: {
      packSlug,
      pulledAtTimestamp: { gte: cutoff },
      deletedAt: null,
    },
    select: {
      fmvUsdCents: true,
      packPriceUsdCents: true,
      netGainUsdCents: true,
      tier: true,
      gradingCompany: true,
      grade: true,
    },
  });

  // Net gain pool (excludes nulls).
  const gains: number[] = [];
  let wins = 0;
  for (const p of pulls) {
    if (typeof p.netGainUsdCents === 'number' && Number.isFinite(p.netGainUsdCents)) {
      gains.push(p.netGainUsdCents);
      if (p.netGainUsdCents > 0) wins += 1;
    }
  }

  const totalPulls = gains.length;
  const meanNetGainUsdCents =
    totalPulls > 0
      ? Math.round(gains.reduce((acc, v) => acc + v, 0) / totalPulls)
      : 0;
  const sortedGains = [...gains].sort((a, b) => a - b);
  const medianNetGainUsdCents = computeMedian(sortedGains);
  const winRate = totalPulls > 0 ? wins / totalPulls : 0;

  // Top 5 by netGain (DESC). Stable secondary order does not matter for the
  // headline; just take the largest 5.
  const top5: OddsTopEntry[] = pulls
    .filter((p): p is PullRow & { netGainUsdCents: number } =>
      typeof p.netGainUsdCents === 'number' && Number.isFinite(p.netGainUsdCents)
    )
    .sort((a, b) => b.netGainUsdCents - a.netGainUsdCents)
    .slice(0, 5)
    .map((p) => ({
      netGainUsdCents: p.netGainUsdCents,
      tier: p.tier,
      gradingCompany: p.gradingCompany,
      grade: p.grade,
    }));

  // By-tier breakdown: only pulls with a known tier AND known netGain.
  const tierAccum: Record<string, { sum: number; count: number }> = {};
  for (const p of pulls) {
    if (
      typeof p.tier === 'string' &&
      p.tier.length > 0 &&
      typeof p.netGainUsdCents === 'number' &&
      Number.isFinite(p.netGainUsdCents)
    ) {
      const key = p.tier;
      const existing = tierAccum[key] ?? { sum: 0, count: 0 };
      existing.sum += p.netGainUsdCents;
      existing.count += 1;
      tierAccum[key] = existing;
    }
  }
  const byTier: Record<string, OddsTierBucket> = {};
  for (const [key, agg] of Object.entries(tierAccum)) {
    byTier[key] = {
      count: agg.count,
      avgNetGain: agg.count > 0 ? Math.round(agg.sum / agg.count) : 0,
    };
  }

  return {
    packSlug,
    windowDays: ODDS_WINDOW_DAYS,
    windowStartAt: cutoff,
    windowEndAt: now,
    totalPulls,
    meanNetGainUsdCents,
    medianNetGainUsdCents,
    winRate,
    top5,
    byTier,
  };
};

/**
 * Pure kernels behind the dual-window odds surface. Extracted from
 * `./index.ts` so unit tests can exercise `computeTierFrequency` and
 * `computeDivergence` without pulling in the Prisma client (which is only
 * available after `bun run db:push`).
 *
 * No I/O in this file. No Prisma import. Add only pure functions here.
 */

/**
 * Per-tier frequency aggregator. Consumed by both the upstream-recent
 * odds path (aggregating `cardPack.recentOpenedPacks`) and the empirical-90d
 * odds path (aggregating our indexed Pull rows).
 *
 * Returns entries sorted by count DESC. Tier keys are lowercased before
 * aggregation so "Rare" and "rare" collapse into one bucket.
 */
export interface TierFrequencyEntry {
  tier: string;
  count: number;
  pct: number; // 0..1
}

export const computeTierFrequency = (
  tiers: Array<string | null | undefined>
): { total: number; entries: TierFrequencyEntry[] } => {
  const buckets = new Map<string, number>();
  let total = 0;
  for (const raw of tiers) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim().toLowerCase();
    if (key.length === 0) continue;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
    total += 1;
  }
  const entries: TierFrequencyEntry[] = [];
  for (const [tier, count] of buckets.entries()) {
    entries.push({ tier, count, pct: total > 0 ? count / total : 0 });
  }
  entries.sort((a, b) => b.count - a.count);
  return { total, entries };
};

/**
 * Divergence detector. Given two tier-frequency distributions (percentages),
 * return the per-tier delta and a `flagged` boolean for entries where the
 * absolute pct gap exceeds `threshold` (default 20 percentage points, per
 * spec). Both inputs' `pct` fields are on the [0,1] scale; divergence output
 * is in percentage POINTS (0-100 scale) so operators reading the JSON get a
 * scan-friendly number.
 */
export interface DivergenceEntry {
  tier: string;
  upstreamPct: number;      // 0..1
  empiricalPct: number;     // 0..1
  deltaPct: number;         // percentage points, signed (upstream - empirical)
  flagged: boolean;
}

export const computeDivergence = (
  upstream: TierFrequencyEntry[],
  empirical: TierFrequencyEntry[],
  thresholdPct = 20
): DivergenceEntry[] => {
  const upMap = new Map<string, number>();
  for (const e of upstream) upMap.set(e.tier, e.pct);
  const empMap = new Map<string, number>();
  for (const e of empirical) empMap.set(e.tier, e.pct);
  const tiers = new Set<string>([...upMap.keys(), ...empMap.keys()]);
  const out: DivergenceEntry[] = [];
  for (const tier of tiers) {
    const upstreamPct = upMap.get(tier) ?? 0;
    const empiricalPct = empMap.get(tier) ?? 0;
    const deltaPct = Math.round((upstreamPct - empiricalPct) * 100 * 100) / 100;
    out.push({
      tier,
      upstreamPct,
      empiricalPct,
      deltaPct,
      flagged: Math.abs(deltaPct) > thresholdPct,
    });
  }
  out.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
  return out;
};

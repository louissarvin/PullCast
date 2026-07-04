/**
 * ASCII sparkline renderer.
 *
 * Used by the /market Discord command to fit a 30-day index series into a
 * one-line embed field. We map each numeric datum to one of eight block
 * characters proportional to its position in [min, max].
 *
 * Rules:
 *  - Empty / single-element series returns "".
 *  - All-equal series returns a flat mid-height block for every point (no
 *    divide-by-zero, and visually communicates "no motion").
 *  - Non-finite inputs are dropped silently; if the entire input is unusable
 *    we return "".
 */

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export const renderSparkline = (series: readonly number[]): string => {
  if (!Array.isArray(series) || series.length === 0) return '';
  const clean = series.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (clean.length === 0) return '';
  if (clean.length === 1) return BLOCKS[3];

  let min = clean[0];
  let max = clean[0];
  for (const n of clean) {
    if (n < min) min = n;
    if (n > max) max = n;
  }

  if (max === min) {
    // Flat series: render at mid-height. Avoids /0 and communicates no motion.
    return BLOCKS[3].repeat(clean.length);
  }

  const span = max - min;
  const denom = BLOCKS.length - 1;
  let out = '';
  for (const n of clean) {
    const t = (n - min) / span;
    const idx = Math.max(0, Math.min(denom, Math.round(t * denom)));
    out += BLOCKS[idx];
  }
  return out;
};

/**
 * Convenience for the Index API sparkline shape (`SeriesPoint[]`). Extracts
 * `usdCents` in order and hands off to `renderSparkline`.
 */
export const renderSparklineFromSeriesPoints = (
  points: ReadonlyArray<{ usdCents?: unknown }>
): string => {
  if (!Array.isArray(points)) return '';
  const values: number[] = [];
  for (const p of points) {
    const v = (p as { usdCents?: unknown }).usdCents;
    if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
  }
  return renderSparkline(values);
};

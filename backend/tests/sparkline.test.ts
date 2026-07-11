/**
 * D8 ASCII sparkline renderer tests.
 *
 * Covers the /market embed use-case: 30-point usdCents series scaled into
 * eight block characters. Also covers edge cases:
 *  - Empty series returns ""
 *  - Single element returns one block
 *  - All-equal series returns flat mid-height row (no /0)
 *  - Non-finite values are dropped
 */

import { describe, test, expect } from 'bun:test';

import {
  renderSparkline,
  renderSparklineFromSeriesPoints,
} from '../src/lib/renaiss-index/sparkline.ts';

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

describe('renderSparkline', () => {
  test('returns "" for empty input', () => {
    expect(renderSparkline([])).toBe('');
  });

  test('returns a single mid-height block for 1-element input', () => {
    expect(renderSparkline([100])).toBe('▄');
  });

  test('returns flat mid-height row for all-equal input (no divide-by-zero)', () => {
    const out = renderSparkline([50, 50, 50, 50, 50]);
    expect(out.length).toBe(5);
    // Every char must be the flat mid-height block.
    for (const ch of out) {
      expect(ch).toBe('▄');
    }
  });

  test('maps min to lowest block, max to highest block', () => {
    const out = renderSparkline([0, 1000]);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(BLOCKS[0]);
    expect(out[1]).toBe(BLOCKS[BLOCKS.length - 1]);
  });

  test('rejects non-finite values (drops them from the output)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = renderSparkline([1, NaN, 5, Infinity, 10] as any);
    // Non-finite values dropped; only 3 usable data points remain.
    expect(out.length).toBe(3);
  });

  test('renders a rising 30-point series with monotonically non-decreasing blocks', () => {
    const series: number[] = [];
    for (let i = 0; i < 30; i += 1) series.push(i);
    const out = renderSparkline(series);
    expect(out.length).toBe(30);
    // Each block should be >= the previous block (rising input).
    for (let i = 1; i < out.length; i += 1) {
      expect(BLOCKS.indexOf(out[i] as (typeof BLOCKS)[number])).toBeGreaterThanOrEqual(
        BLOCKS.indexOf(out[i - 1] as (typeof BLOCKS)[number])
      );
    }
    expect(out[0]).toBe(BLOCKS[0]);
    expect(out[out.length - 1]).toBe(BLOCKS[BLOCKS.length - 1]);
  });
});

describe('renderSparklineFromSeriesPoints', () => {
  test('extracts usdCents in order', () => {
    const points = [
      { t: 'a', usdCents: 100 },
      { t: 'b', usdCents: 200 },
      { t: 'c', usdCents: 300 },
    ];
    const out = renderSparklineFromSeriesPoints(points);
    expect(out.length).toBe(3);
    expect(out[0]).toBe(BLOCKS[0]);
    expect(out[2]).toBe(BLOCKS[BLOCKS.length - 1]);
  });

  test('returns "" for empty or missing input', () => {
    expect(renderSparklineFromSeriesPoints([])).toBe('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(renderSparklineFromSeriesPoints(null as any)).toBe('');
  });

  test('handles the fixture-shaped 30-point Pokemon sparkline', () => {
    // Values pulled from the live Pokemon Index sparkline on 2026-07-01.
    // Series drops from ~1.46M down to ~1.23M over 30 days: expect first
    // block to be top-ish and last block to be low-ish.
    const points = [
      1462829, 1461326, 1459374, 1463050, 1459921, 1463375, 1456350, 1439854,
      1424591, 1418295, 1414721, 1408336, 1398767, 1396186, 1393404, 1387518,
      1378330, 1371499, 1363802, 1361052, 1348444, 1330299, 1304333, 1268864,
      1250802, 1239405, 1228475, 1226310, 1226411, 1228225,
    ].map((usdCents) => ({ t: '2026-06-01T00:00:00Z', usdCents }));
    const out = renderSparklineFromSeriesPoints(points);
    expect(out.length).toBe(30);
    // First block should be one of the highest (top of range).
    const firstIdx = BLOCKS.indexOf(out[0] as (typeof BLOCKS)[number]);
    expect(firstIdx).toBeGreaterThanOrEqual(6);
    // Last block should be near the bottom.
    const lastIdx = BLOCKS.indexOf(out[out.length - 1] as (typeof BLOCKS)[number]);
    expect(lastIdx).toBeLessThanOrEqual(1);
  });
});

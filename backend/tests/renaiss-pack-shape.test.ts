/**
 * Task A hotfix regression tests for `renaissPackSchema`.
 *
 * The `/v0/packs/{slug}` upstream has shipped TWO shapes:
 *
 *   LEGACY (older; still accepted for backward compat)
 *     { slug, packPriceInUSD, recentOpenedPacks: [{ ... pulledAtTimestamp: ISO }] }
 *
 *   CURRENT (live 2026-07-02)
 *     { cardPack: { slug, priceInUsdt, recentOpenedPacks: [{ ... pulledAtTimestamp: <unix seconds> }] } }
 *
 * The schema in `src/lib/renaiss/schemas.ts` MUST accept BOTH shapes and
 * normalize them to a single canonical output so the indexer worker does not
 * silently drop every poll after an upstream drift.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  renaissPackSchema,
  renaissPullSchema,
} from '../src/lib/renaiss/schemas.ts';

const readFixture = (name: string): unknown => {
  const path = resolve(process.cwd(), 'tests', 'fixtures', 'renaiss', name);
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
};

describe('renaissPackSchema — shape tolerance', () => {
  test('LEGACY: root-level fields + ISO string pulledAtTimestamp parses', () => {
    const fixture = readFixture('pack-legacy-root-level.json');
    const result = renaissPackSchema.safeParse(fixture);
    if (!result.success) {
      // Surface the first ZodError issue for easier debugging on drift.
      console.error('legacy shape parse error:', result.error.issues[0]);
    }
    expect(result.success).toBe(true);
    if (!result.success) return;

    const parsed = result.data;
    expect((parsed as { _shapeVariant?: string })._shapeVariant).toBe(
      'root-level'
    );
    expect(parsed.slug).toBe('legacy-pack');
    // Legacy shape carries packPriceInUSD directly.
    expect(parsed.packPriceInUSD).toBe('7350');
    expect(Array.isArray(parsed.recentOpenedPacks)).toBe(true);
    expect(parsed.recentOpenedPacks?.length).toBe(2);
    // ISO string timestamps pass through untouched.
    expect(parsed.recentOpenedPacks?.[0].pulledAtTimestamp).toBe(
      '2026-07-01T12:00:00.000Z'
    );
  });

  test('CURRENT: cardPack-wrapped fields + numeric pulledAtTimestamp parses and normalizes', () => {
    const fixture = readFixture('pack-eden-live-2026-07-02.json');
    const result = renaissPackSchema.safeParse(fixture);
    if (!result.success) {
      console.error('current shape parse error:', result.error.issues[0]);
    }
    expect(result.success).toBe(true);
    if (!result.success) return;

    const parsed = result.data;
    expect((parsed as { _shapeVariant?: string })._shapeVariant).toBe(
      'cardPack-wrapped'
    );
    expect(parsed.slug).toBe('eden-pack');
    // Current shape uses priceInUsdt (wei) instead of packPriceInUSD.
    expect((parsed as { priceInUsdt?: string }).priceInUsdt).toBe(
      '150000000000000000000'
    );
    expect(Array.isArray(parsed.recentOpenedPacks)).toBe(true);
    const pulls = parsed.recentOpenedPacks ?? [];
    expect(pulls.length).toBeGreaterThan(0);
    // Numeric unix-seconds timestamps MUST be normalized to ISO strings so
    // downstream Date.parse consumers all behave the same.
    const first = pulls[0];
    expect(typeof first.pulledAtTimestamp).toBe('string');
    const parsedTs = Date.parse(first.pulledAtTimestamp);
    expect(Number.isFinite(parsedTs)).toBe(true);
    expect(parsedTs).toBeGreaterThan(1_700_000_000_000);
  });

  test('BOTH shapes normalize to a compatible canonical shape', () => {
    const legacy = renaissPackSchema.parse(readFixture('pack-legacy-root-level.json'));
    const current = renaissPackSchema.parse(readFixture('pack-eden-live-2026-07-02.json'));

    // Both expose the same top-level keys downstream cares about.
    for (const key of ['slug', 'recentOpenedPacks', '_shapeVariant'] as const) {
      expect(key in legacy).toBe(true);
      expect(key in current).toBe(true);
    }
    // Both produce ISO-string timestamps regardless of upstream type.
    for (const p of [
      ...(legacy.recentOpenedPacks ?? []),
      ...(current.recentOpenedPacks ?? []),
    ]) {
      expect(typeof p.pulledAtTimestamp).toBe('string');
      expect(Number.isFinite(Date.parse(p.pulledAtTimestamp))).toBe(true);
    }
  });

  test('missing recentOpenedPacks does not crash the parser', () => {
    // Legacy shape variant without the array.
    const rootNoArr = { slug: 'x', packPriceInUSD: '100' };
    const okRoot = renaissPackSchema.safeParse(rootNoArr);
    expect(okRoot.success).toBe(true);
    if (okRoot.success) {
      expect(okRoot.data.recentOpenedPacks).toBeUndefined();
      expect((okRoot.data as { _shapeVariant?: string })._shapeVariant).toBe(
        'root-level'
      );
    }

    // Current shape variant with empty array.
    const wrappedEmpty = { cardPack: { slug: 'y', recentOpenedPacks: [] } };
    const okWrapped = renaissPackSchema.safeParse(wrappedEmpty);
    expect(okWrapped.success).toBe(true);
    if (okWrapped.success) {
      expect(okWrapped.data.recentOpenedPacks).toEqual([]);
      expect((okWrapped.data as { _shapeVariant?: string })._shapeVariant).toBe(
        'cardPack-wrapped'
      );
    }

    // Current shape variant with the array key entirely absent.
    const wrappedNoArr = { cardPack: { slug: 'z' } };
    const okWrappedNoArr = renaissPackSchema.safeParse(wrappedNoArr);
    expect(okWrappedNoArr.success).toBe(true);
    if (okWrappedNoArr.success) {
      expect(okWrappedNoArr.data.recentOpenedPacks).toBeUndefined();
    }
  });
});

describe('renaissPullSchema — timestamp normalization', () => {
  test('numeric unix-seconds timestamp is normalized to ISO string', () => {
    const raw = {
      collectibleTokenId: 'tok-1',
      pulledAtTimestamp: 1782950798, // seconds; live-observed value
    };
    const parsed = renaissPullSchema.parse(raw);
    expect(typeof parsed.pulledAtTimestamp).toBe('string');
    expect(Date.parse(parsed.pulledAtTimestamp)).toBe(1782950798 * 1000);
  });

  test('numeric unix-ms timestamp is preserved as-is (heuristic threshold)', () => {
    const raw = {
      collectibleTokenId: 'tok-2',
      pulledAtTimestamp: 1_782_950_798_000, // already ms; >= 1e12
    };
    const parsed = renaissPullSchema.parse(raw);
    expect(Date.parse(parsed.pulledAtTimestamp)).toBe(1_782_950_798_000);
  });

  test('ISO string timestamp passes through untouched', () => {
    const raw = {
      collectibleTokenId: 'tok-3',
      pulledAtTimestamp: '2026-07-01T12:00:00.000Z',
    };
    const parsed = renaissPullSchema.parse(raw);
    expect(parsed.pulledAtTimestamp).toBe('2026-07-01T12:00:00.000Z');
  });

  test('zero unix seconds parses to epoch ISO (edge case)', () => {
    // Some upstream fallbacks emit 0 when no pull time is recorded. The
    // schema still normalizes; downstream cursor filter rejects it because
    // it will never be > lastSeenTimestamp.
    const raw = {
      collectibleTokenId: 'tok-4',
      pulledAtTimestamp: 0,
    };
    const parsed = renaissPullSchema.parse(raw);
    expect(parsed.pulledAtTimestamp).toBe('1970-01-01T00:00:00.000Z');
  });
});

/**
 * Big Trade Alert filter, cursor, embed, and per-channel threshold tests.
 *
 * These tests exercise the pure functions in
 * `src/workers/bigTradeAlert.filters.ts`. The DB + Discord side of the worker
 * is not exercised here (that requires a live Prisma client + Discord token
 * and is covered by integration testing at demo time).
 */

import { describe, test, expect } from 'bun:test';

import type { IndexTrade } from '../src/lib/renaiss-index/index.ts';
import {
  filterQualifyingTrades,
  newestObservedAtMs,
  buildBigTradeAlertEmbed,
  buildBigTradeDigestEmbed,
  parseChannelThresholdCents,
  parseObservedAt,
  sourceLabel,
} from '../src/workers/bigTradeAlert.filters.ts';

const makeTrade = (overrides: Partial<IndexTrade> = {}): IndexTrade => ({
  source: 'snkrdunk',
  bucket: 'public',
  displayName: 'snkrdunk',
  observedAt: '2026-07-02T04:00:00.000Z',
  kind: 'transaction',
  priceUsdCents: 600000,
  priceMinor: 970000,
  currency: 'JPY',
  sourceUrl: 'https://snkrdunk.com/en/trading-cards/671486',
  card: {
    game: 'pokemon',
    name: 'Charizard',
    setName: 'Base Set',
    setCode: 'BASE',
    cardNumber: '004',
    grade: '10 Gem Mint',
    gradeLabel: 'PSA 10',
    href: '/card/pokemon/base/004-charizard',
    imageUrl: 'https://cdn.renaiss.xyz/charizard.webp',
  },
  ...overrides,
});

describe('filterQualifyingTrades', () => {
  const threshold = 500000; // $5,000

  test('keeps trades at or above threshold with kind=transaction', () => {
    const trades: IndexTrade[] = [
      makeTrade({ priceUsdCents: 500000, observedAt: '2026-07-02T04:00:00Z' }),
      makeTrade({ priceUsdCents: 1000000, observedAt: '2026-07-02T04:05:00Z' }),
    ];
    const result = filterQualifyingTrades({
      trades,
      thresholdCents: threshold,
      cursorMs: null,
    });
    expect(result.length).toBe(2);
    // Sorted oldest-first
    expect(result[0].observedAt.toISOString()).toBe('2026-07-02T04:00:00.000Z');
    expect(result[1].observedAt.toISOString()).toBe('2026-07-02T04:05:00.000Z');
  });

  test('drops trades below threshold', () => {
    const trades: IndexTrade[] = [
      makeTrade({ priceUsdCents: 499999 }),
      makeTrade({ priceUsdCents: 8028 }), // real-world snkrdunk sample
    ];
    const result = filterQualifyingTrades({
      trades,
      thresholdCents: threshold,
      cursorMs: null,
    });
    expect(result.length).toBe(0);
  });

  test('drops trades with kind !== transaction (e.g. listing)', () => {
    const trades: IndexTrade[] = [
      makeTrade({ priceUsdCents: 5_000_000, kind: 'listing' }),
      makeTrade({ priceUsdCents: 5_000_000, kind: 'transaction' }),
    ];
    const result = filterQualifyingTrades({
      trades,
      thresholdCents: threshold,
      cursorMs: null,
    });
    expect(result.length).toBe(1);
    expect(result[0].trade.kind).toBe('transaction');
  });

  test('drops trades with unparseable observedAt', () => {
    const trades: IndexTrade[] = [
      makeTrade({ priceUsdCents: 5_000_000, observedAt: 'not-a-date' }),
      makeTrade({ priceUsdCents: 5_000_000, observedAt: undefined, occurredAt: undefined }),
    ];
    const result = filterQualifyingTrades({
      trades,
      thresholdCents: threshold,
      cursorMs: null,
    });
    expect(result.length).toBe(0);
  });

  test('drops trades at or before cursor (idempotent re-run)', () => {
    const cursorMs = new Date('2026-07-02T04:00:00Z').getTime();
    const trades: IndexTrade[] = [
      makeTrade({ priceUsdCents: 1_000_000, observedAt: '2026-07-02T03:00:00Z' }),
      makeTrade({ priceUsdCents: 1_000_000, observedAt: '2026-07-02T04:00:00Z' }),
      makeTrade({ priceUsdCents: 1_000_000, observedAt: '2026-07-02T04:05:00Z' }),
    ];
    const result = filterQualifyingTrades({
      trades,
      thresholdCents: threshold,
      cursorMs,
    });
    expect(result.length).toBe(1);
    expect(result[0].observedAt.toISOString()).toBe('2026-07-02T04:05:00.000Z');
  });

  test('idempotent: same input twice with advancing cursor alerts each trade exactly once', () => {
    const trades: IndexTrade[] = [
      makeTrade({ priceUsdCents: 1_000_000, observedAt: '2026-07-02T04:00:00Z' }),
      makeTrade({ priceUsdCents: 1_000_000, observedAt: '2026-07-02T04:05:00Z' }),
      makeTrade({ priceUsdCents: 1_000_000, observedAt: '2026-07-02T04:10:00Z' }),
    ];

    // First run: no cursor -> everything qualifies.
    const first = filterQualifyingTrades({
      trades,
      thresholdCents: threshold,
      cursorMs: null,
    });
    expect(first.length).toBe(3);

    // Advance cursor to newest.
    const nextCursor = newestObservedAtMs(first);
    expect(nextCursor).not.toBeNull();

    // Second run with same trades: cursor swallows everything.
    const second = filterQualifyingTrades({
      trades,
      thresholdCents: threshold,
      cursorMs: nextCursor,
    });
    expect(second.length).toBe(0);
  });

  test('newestObservedAtMs picks the max observedAt', () => {
    const trades: IndexTrade[] = [
      makeTrade({ observedAt: '2026-07-02T04:00:00Z' }),
      makeTrade({ observedAt: '2026-07-02T04:10:00Z' }),
      makeTrade({ observedAt: '2026-07-02T04:05:00Z' }),
    ];
    const qualifying = filterQualifyingTrades({
      trades,
      thresholdCents: threshold,
      cursorMs: null,
    });
    const newest = newestObservedAtMs(qualifying);
    expect(newest).toBe(new Date('2026-07-02T04:10:00Z').getTime());
  });

  test('newestObservedAtMs returns null on empty', () => {
    expect(newestObservedAtMs([])).toBeNull();
  });

  test('falls back to occurredAt when observedAt is missing (legacy field)', () => {
    const trade = makeTrade({
      observedAt: undefined,
      occurredAt: '2026-07-02T05:00:00Z',
    });
    const parsed = parseObservedAt(trade);
    expect(parsed).not.toBeNull();
    expect(parsed?.toISOString()).toBe('2026-07-02T05:00:00.000Z');
  });
});

describe('buildBigTradeAlertEmbed', () => {
  test('renders required fields for a live-shaped trade', () => {
    const qualifying = filterQualifyingTrades({
      trades: [makeTrade({ priceUsdCents: 1_234_500 })],
      thresholdCents: 500000,
      cursorMs: null,
    })[0];

    const embed = buildBigTradeAlertEmbed({ qualifying });
    const json = embed.toJSON();

    expect(json.title).toContain('Charizard');
    expect(json.description).toContain('Base Set');
    expect(json.description).toContain('PSA 10');
    expect(json.color).toBe(0xf1c40f);
    // Discord.js's setFooter accepts either { text } or a passed string.
    expect(json.footer?.text).toContain('Not financial advice');
    // Thumbnail from card.imageUrl
    expect(json.thumbnail?.url).toBe('https://cdn.renaiss.xyz/charizard.webp');
    // Price field
    const fields = json.fields ?? [];
    const priceField = fields.find((f) => f.name === 'Price');
    expect(priceField).toBeDefined();
    expect(priceField?.value).toContain('$12,345'); // 1_234_500 cents
    // Source field with human label
    const sourceField = fields.find((f) => f.name === 'Source');
    expect(sourceField?.value).toBe('snkrdunk');
    // View source with sanitized URL
    const viewSource = fields.find((f) => f.name === 'View source');
    expect(viewSource?.value).toContain('https://snkrdunk.com/');
    // Disclosure field always present
    const disclosureField = fields.find((f) => f.value?.includes('Not financial advice'));
    expect(disclosureField).toBeDefined();
  });

  test('adds currency line for non-USD trades (JPY sample)', () => {
    const qualifying = filterQualifyingTrades({
      trades: [
        makeTrade({
          priceUsdCents: 800000,
          priceMinor: 12_970_00,
          currency: 'JPY',
        }),
      ],
      thresholdCents: 500000,
      cursorMs: null,
    })[0];
    const embed = buildBigTradeAlertEmbed({ qualifying });
    const fields = embed.toJSON().fields ?? [];
    const original = fields.find((f) => f.name === 'Original');
    expect(original).toBeDefined();
    expect(original?.value.startsWith('¥')).toBe(true);
  });

  test('omits View source when sourceUrl is not http(s)', () => {
    const qualifying = filterQualifyingTrades({
      trades: [
        makeTrade({
          priceUsdCents: 800000,
          sourceUrl: 'javascript:alert(1)',
        }),
      ],
      thresholdCents: 500000,
      cursorMs: null,
    })[0];
    const embed = buildBigTradeAlertEmbed({ qualifying });
    const fields = embed.toJSON().fields ?? [];
    const viewSource = fields.find((f) => f.name === 'View source');
    expect(viewSource).toBeUndefined();
  });
});

describe('buildBigTradeDigestEmbed', () => {
  test('lists top trades sorted by price desc', () => {
    const trades: IndexTrade[] = [
      makeTrade({ priceUsdCents: 600_000, observedAt: '2026-07-02T04:00:00Z' }),
      makeTrade({
        priceUsdCents: 2_000_000,
        observedAt: '2026-07-02T04:05:00Z',
        card: {
          ...(makeTrade().card as NonNullable<IndexTrade['card']>),
          name: 'Blastoise',
        },
      }),
      makeTrade({ priceUsdCents: 1_000_000, observedAt: '2026-07-02T04:10:00Z' }),
    ];
    const qualifying = filterQualifyingTrades({
      trades,
      thresholdCents: 500000,
      cursorMs: null,
    });

    const embed = buildBigTradeDigestEmbed({
      qualifying,
      totalCount: qualifying.length,
    });
    const json = embed.toJSON();
    expect(json.title).toContain('3');
    // Blastoise should appear before Charizard because it's the biggest trade
    const desc = json.description ?? '';
    expect(desc.indexOf('Blastoise')).toBeGreaterThan(-1);
    expect(desc.indexOf('Blastoise')).toBeLessThan(desc.indexOf('Charizard'));
    // Footer disclosure present
    expect(json.footer?.text).toContain('Not financial advice');
  });
});

describe('parseChannelThresholdCents', () => {
  test('returns the parsed override', () => {
    const meta = JSON.stringify({ threshold_usd_cents: 1_000_000 });
    expect(parseChannelThresholdCents(meta)).toBe(1_000_000);
  });

  test('returns null on missing or invalid values', () => {
    expect(parseChannelThresholdCents(null)).toBeNull();
    expect(parseChannelThresholdCents('')).toBeNull();
    expect(parseChannelThresholdCents('not-json')).toBeNull();
    expect(parseChannelThresholdCents('{}')).toBeNull();
    expect(parseChannelThresholdCents(JSON.stringify({ threshold_usd_cents: 0 }))).toBeNull();
    expect(
      parseChannelThresholdCents(JSON.stringify({ threshold_usd_cents: -1 }))
    ).toBeNull();
    expect(
      parseChannelThresholdCents(JSON.stringify({ threshold_usd_cents: 'nope' }))
    ).toBeNull();
  });

  test('per-channel override changes qualifying-set membership', () => {
    const trades: IndexTrade[] = [
      makeTrade({ priceUsdCents: 500_000 }), // meets $5k default
      makeTrade({ priceUsdCents: 2_000_000 }), // meets stricter $10k override
    ];
    const channelMeta = JSON.stringify({ threshold_usd_cents: 1_000_000 });
    const override = parseChannelThresholdCents(channelMeta);
    expect(override).toBe(1_000_000);

    const global = filterQualifyingTrades({
      trades,
      thresholdCents: 500_000,
      cursorMs: null,
    });
    const channelOnly = global.filter(
      (q) => q.priceUsdCents >= (override ?? 500_000)
    );
    expect(global.length).toBe(2);
    expect(channelOnly.length).toBe(1);
    expect(channelOnly[0].priceUsdCents).toBe(2_000_000);
  });
});

describe('D8-M-5 adversarial input (SSRF / layout attacks)', () => {
  const makeQualifying = (cardOverrides: Partial<NonNullable<IndexTrade['card']>>) => {
    return filterQualifyingTrades({
      trades: [
        makeTrade({
          priceUsdCents: 1_000_000,
          card: {
            ...(makeTrade().card as NonNullable<IndexTrade['card']>),
            ...cardOverrides,
          },
        }),
      ],
      thresholdCents: 500_000,
      cursorMs: null,
    })[0];
  };

  test('blocks non-allowlisted thumbnail host', () => {
    const qualifying = makeQualifying({
      imageUrl: 'https://attacker.com/tracker.png',
    });
    const embed = buildBigTradeAlertEmbed({ qualifying });
    const json = embed.toJSON();
    expect(json.thumbnail).toBeUndefined();
  });

  test('blocks javascript: thumbnail URL', () => {
    const qualifying = makeQualifying({
      imageUrl: 'javascript:alert(1)',
    });
    const embed = buildBigTradeAlertEmbed({ qualifying });
    const json = embed.toJSON();
    expect(json.thumbnail).toBeUndefined();
  });

  test('blocks http (non-https) thumbnail even on Renaiss host', () => {
    const qualifying = makeQualifying({
      imageUrl: 'http://cdn.renaiss.xyz/x.png',
    });
    const embed = buildBigTradeAlertEmbed({ qualifying });
    expect(embed.toJSON().thumbnail).toBeUndefined();
  });

  test('blocks internal IP literal', () => {
    const qualifying = makeQualifying({
      imageUrl: 'http://169.254.169.254/latest/meta-data/',
    });
    expect(buildBigTradeAlertEmbed({ qualifying }).toJSON().thumbnail).toBeUndefined();
  });

  test('accepts allowlisted https thumbnail from cdn.renaiss.xyz', () => {
    const qualifying = makeQualifying({
      imageUrl: 'https://cdn.renaiss.xyz/card.webp',
    });
    const embed = buildBigTradeAlertEmbed({ qualifying });
    expect(embed.toJSON().thumbnail?.url).toBe('https://cdn.renaiss.xyz/card.webp');
  });

  test('accepts allowlisted https thumbnail from api.renaissos.com', () => {
    const qualifying = makeQualifying({
      imageUrl: 'https://api.renaissos.com/card.webp',
    });
    const embed = buildBigTradeAlertEmbed({ qualifying });
    expect(embed.toJSON().thumbnail?.url).toBe('https://api.renaissos.com/card.webp');
  });

  test('caps oversized card name in single-alert embed at 128 chars', () => {
    const hugeName = 'A'.repeat(2000);
    const qualifying = makeQualifying({ name: hugeName });
    const embed = buildBigTradeAlertEmbed({ qualifying });
    const title = embed.toJSON().title ?? '';
    // Title = "Big Trade Alert: " + cardName. Ensure the cardName portion is
    // capped at 128 chars.
    const namePortion = title.replace(/^Big Trade Alert: /, '');
    expect(namePortion.length).toBeLessThanOrEqual(128);
  });

  test('strips CR / LF from card name so the embed layout is stable', () => {
    const qualifying = makeQualifying({
      name: 'Charizard\r\n**Fake price**\nOverride',
    });
    const embed = buildBigTradeAlertEmbed({ qualifying });
    const title = embed.toJSON().title ?? '';
    expect(title).not.toContain('\n');
    expect(title).not.toContain('\r');
  });

  test('digest embed caps a 10-line description well under 4096 chars even with 500-char names', () => {
    const trades: IndexTrade[] = Array.from({ length: 15 }).map((_, i) =>
      makeTrade({
        priceUsdCents: 1_000_000 + i,
        observedAt: `2026-07-02T04:${String(i).padStart(2, '0')}:00Z`,
        card: {
          ...(makeTrade().card as NonNullable<IndexTrade['card']>),
          name: 'Bomb'.repeat(200), // 800 chars
          gradeLabel: 'Grade'.repeat(200), // 1000 chars
        },
      })
    );
    const qualifying = filterQualifyingTrades({
      trades,
      thresholdCents: 500_000,
      cursorMs: null,
    });
    const embed = buildBigTradeDigestEmbed({
      qualifying,
      totalCount: qualifying.length,
    });
    const desc = embed.toJSON().description ?? '';
    // Discord embed description hard cap is 4096. We should be comfortably
    // under that even with all 10 lines carrying capped 128-char names +
    // 128-char grades + price + source.
    expect(desc.length).toBeLessThan(4096);
  });

  test('digest embed drops CR / LF injected via card name so lines are not fabricated', () => {
    const trades: IndexTrade[] = [
      makeTrade({
        priceUsdCents: 1_000_000,
        card: {
          ...(makeTrade().card as NonNullable<IndexTrade['card']>),
          name: 'Charizard\n$999,999 — FakeCard · fake-source',
        },
      }),
    ];
    const qualifying = filterQualifyingTrades({
      trades,
      thresholdCents: 500_000,
      cursorMs: null,
    });
    const embed = buildBigTradeDigestEmbed({
      qualifying,
      totalCount: qualifying.length,
    });
    const desc = embed.toJSON().description ?? '';
    // Preamble contributes one \n but the per-trade line must not add a
    // second one from the injected \n in card.name.
    const perTradeLines = desc
      .split('\n')
      .filter((l) => l.startsWith('$'));
    // Exactly one trade -> exactly one $-prefixed line.
    expect(perTradeLines.length).toBe(1);
  });
});

describe('sourceLabel', () => {
  test('maps known sources to human labels', () => {
    expect(sourceLabel('snkrdunk')).toBe('snkrdunk');
    expect(sourceLabel('public')).toBe('Public marketplaces');
    expect(sourceLabel('partner')).toBe('Partner shops');
    expect(sourceLabel('renaiss-internal')).toBe('Renaiss vault sales');
  });

  test('falls through unknown sources', () => {
    expect(sourceLabel('brand-new-source')).toBe('brand-new-source');
    expect(sourceLabel(undefined)).toBe('unknown');
    expect(sourceLabel(null)).toBe('unknown');
    expect(sourceLabel('')).toBe('unknown');
  });
});

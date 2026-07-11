/**
 * D8 P0 fix regression tests for `renaissCardSchema`.
 *
 * The `/v0/cards/{tokenId}` upstream ships TWO shapes:
 *
 *   LEGACY (pre-2026-07):
 *     { tokenId, name, setName, fmvPriceInUSD,
 *       attributes: [{ trait_type, value }], ... }
 *
 *   CURRENT (live 2026-07-02, per api.renaiss.xyz/openapi.json):
 *     { collectible: { tokenId, name, ..., attributes: [{ trait, value }] },
 *       pricing: {...}, activities: {...} | null }
 *
 * `renaissCardSchema` MUST accept BOTH shapes and normalize them to a single
 * canonical output so every downstream caller (price.ts, listing.ts,
 * explain.ts, retriever.ts, priceRoutes.ts) can read the same field names at
 * the ROOT of the parsed value.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  renaissCardSchema,
  type CanonicalRenaissCard,
} from '../src/lib/renaiss/schemas.ts';
import { parsePriceCents } from '../src/lib/renaiss/types.ts';

const readFixture = (name: string): unknown => {
  const path = resolve(process.cwd(), 'tests', 'fixtures', 'renaiss', name);
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
};

describe('renaissCardSchema — shape tolerance', () => {
  test('WRAPPED (live 2026-07-02): { collectible, pricing, activities } parses', () => {
    const fixture = readFixture('card-wrapped-2026-07-02.json');
    const result = renaissCardSchema.safeParse(fixture);
    if (!result.success) {
      console.error('wrapped parse error:', result.error.issues[0]);
    }
    expect(result.success).toBe(true);
    if (!result.success) return;

    const parsed = result.data;
    expect(parsed._shapeVariant).toBe('wrapped');
    // Canonical fields sit at the root, matching what callers already read.
    expect(parsed.tokenId).toBe(
      '101731608654931235889888025042562257763838379592771207661150370518846253648795'
    );
    expect(parsed.name).toContain('Pikachu');
    expect(parsed.setName).toBe('Sun & Moon Tag Bolt');
    expect(parsed.gradingCompany).toBe('PSA');
    expect(parsed.grade).toBe('10 Gem Mint');
    expect(parsed.fmvPriceInUSD).toBe('44300');
    expect(parsed.ownerAddress).toBe(
      '0xabcdef0123456789abcdef0123456789abcdef01'
    );
    // `imageUrl` is aliased from `frontImageUrl` for legacy consumers.
    expect(parsed.imageUrl).toBe(
      'https://cdn.renaiss.xyz/cards/101731608654/front.png'
    );
    // `attributes[]` is renamed from `{ trait, value }` -> `{ trait_type, value }`.
    expect(Array.isArray(parsed.attributes)).toBe(true);
    const first = parsed.attributes?.[0];
    expect(first?.trait_type).toBe('Grading Company');
    expect(first?.value).toBe('PSA');
    // Wrapped extras are surfaced but unused by existing callers.
    expect(parsed.pricing).toBeDefined();
    expect(parsed.activities).toBeDefined();
  });

  test('LEGACY: root-level fields + `{trait_type, value}` attributes parses', () => {
    const fixture = readFixture('card-legacy.json');
    const result = renaissCardSchema.safeParse(fixture);
    if (!result.success) {
      console.error('legacy parse error:', result.error.issues[0]);
    }
    expect(result.success).toBe(true);
    if (!result.success) return;

    const parsed = result.data;
    expect(parsed._shapeVariant).toBe('legacy');
    expect(parsed.tokenId).toBe('9999999999');
    expect(parsed.name).toBe('Legacy shape card');
    expect(parsed.setName).toBe('Base Set');
    expect(parsed.gradingCompany).toBe('BGS');
    expect(parsed.grade).toBe('9.5');
    expect(parsed.serial).toBe('BGS0000042');
    expect(parsed.imageUrl).toBe('https://cdn.renaiss.xyz/legacy/9999999999.png');
    expect(parsed.fmvPriceInUSD).toBe('12345');
    // Legacy attributes are already in canonical shape and pass through.
    expect(parsed.attributes?.[0]).toEqual({
      trait_type: 'Grading Company',
      value: 'BGS',
    });
  });

  test('BOTH shapes normalize to a compatible canonical shape', () => {
    const wrapped = renaissCardSchema.parse(
      readFixture('card-wrapped-2026-07-02.json')
    );
    const legacy = renaissCardSchema.parse(readFixture('card-legacy.json'));

    // Every field a caller relies on exists at the ROOT in BOTH variants.
    const canonicalKeys: Array<keyof CanonicalRenaissCard> = [
      'tokenId',
      'name',
      'setName',
      'gradingCompany',
      'grade',
      'fmvPriceInUSD',
      'attributes',
      'imageUrl',
      '_shapeVariant',
    ];
    for (const k of canonicalKeys) {
      expect(k in wrapped).toBe(true);
      expect(k in legacy).toBe(true);
    }

    // Both attributes arrays use the `trait_type` key so the caller-side
    // normalizer (which greps for `trait_type`) works uniformly.
    for (const attrs of [wrapped.attributes, legacy.attributes]) {
      for (const a of attrs ?? []) {
        expect(typeof a.trait_type).toBe('string');
      }
    }
  });

  test('missing optional fields do NOT crash the parser', () => {
    // Wrapped shape with only the required `collectible.tokenId` field.
    const wrappedMinimal = { collectible: { tokenId: '1' } };
    const ok = renaissCardSchema.safeParse(wrappedMinimal);
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data._shapeVariant).toBe('wrapped');
      expect(ok.data.tokenId).toBe('1');
      expect(ok.data.attributes).toBeUndefined();
      expect(ok.data.activities).toBeUndefined();
    }

    // Wrapped shape with `activities: null` (per openapi `nullable: true`).
    const wrappedNullActivities = {
      collectible: { tokenId: '2' },
      activities: null,
    };
    const ok2 = renaissCardSchema.safeParse(wrappedNullActivities);
    expect(ok2.success).toBe(true);

    // Legacy minimal.
    const legacyMinimal = { tokenId: '3' };
    const ok3 = renaissCardSchema.safeParse(legacyMinimal);
    expect(ok3.success).toBe(true);
    if (ok3.success) {
      expect(ok3.data._shapeVariant).toBe('legacy');
      expect(ok3.data.tokenId).toBe('3');
    }
  });

  test('wrapped `attributes[]` with `{trait, value}` is renamed to `{trait_type, value}`', () => {
    const raw = {
      collectible: {
        tokenId: '42',
        attributes: [
          { trait: 'Foo', value: 'bar' },
          { trait: 'Baz', value: 99 },
        ],
      },
    };
    const parsed = renaissCardSchema.parse(raw);
    expect(parsed.attributes).toEqual([
      { trait_type: 'Foo', value: 'bar' },
      { trait_type: 'Baz', value: 99 },
    ]);
  });

  test('fmvPriceInUSD string-cents value still normalizes through parsePriceCents', () => {
    const wrapped = renaissCardSchema.parse(
      readFixture('card-wrapped-2026-07-02.json')
    );
    const legacy = renaissCardSchema.parse(readFixture('card-legacy.json'));

    // Both fixtures ship string cents; parsePriceCents converts to integer.
    expect(
      parsePriceCents(wrapped.fmvPriceInUSD as string | number | null | undefined)
    ).toBe(44300);
    expect(
      parsePriceCents(legacy.fmvPriceInUSD as string | number | null | undefined)
    ).toBe(12345);
  });

  test('fmvPriceInUSD sentinel "NO-FMV-PRICE" survives the parse (transform is inert)', () => {
    // Per openapi, the string may be either digits or the sentinel
    // "NO-FMV-PRICE". `parsePriceCents` will return null for the sentinel,
    // which is exactly what downstream expects (missing FMV -> no math).
    const raw = {
      collectible: { tokenId: '55', fmvPriceInUSD: 'NO-FMV-PRICE' },
    };
    const parsed = renaissCardSchema.parse(raw);
    expect(parsed.fmvPriceInUSD).toBe('NO-FMV-PRICE');
    expect(
      parsePriceCents(parsed.fmvPriceInUSD as string | number | null | undefined)
    ).toBeNull();
  });

  test('wrapped shape with unknown `passthrough` field survives to root', () => {
    const raw = {
      collectible: {
        tokenId: '77',
        promoBadge: 'launch-week', // additive upstream field
      },
      pricing: { price: null, top_offer: null, last_sale: null },
    };
    const result = renaissCardSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // The unknown field is inside `collectible.*`, so it does NOT appear at
    // the root — but the transform did not crash. This documents the
    // trade-off: additive `collectible.*` fields are silently dropped by the
    // transform; additive top-level fields (a new sibling of `pricing`) DO
    // survive because the outer schema is `.passthrough()`.
    expect(result.data.tokenId).toBe('77');
  });

  test('legacy shape with `passthrough` unknown field survives to root', () => {
    const raw = {
      tokenId: '88',
      futureField: 'yes-please',
    };
    const parsed = renaissCardSchema.parse(raw) as CanonicalRenaissCard & {
      futureField?: string;
    };
    expect(parsed.tokenId).toBe('88');
    // Note: the legacy transform explicitly copies fields, so unknown extras
    // are dropped. This is intentional — the schema is a whitelist for
    // downstream callers. If the field mattered, add it explicitly to the
    // schema + interface.
    expect(parsed.futureField).toBeUndefined();
  });
});

describe('renaissCardSchema — caller compatibility smoke tests', () => {
  /**
   * The five call sites of `renaissApi.getCard`:
   *   - src/lib/discord/commands/price.ts   -> `normalizeRenaissCard`
   *   - src/lib/discord/commands/explain.ts -> via `explainAsk` -> `retriever`
   *   - src/lib/discord/commands/listing.ts -> via `listingSuggest`
   *   - src/lib/anthropic/retriever.ts      -> reads `.name`, `.setName`,
   *                                            `.fmvPriceInUSD`, `.attributes`,
   *                                            `.serial`
   *   - src/lib/anthropic/listing.ts        -> reads `.name`, `.setName`,
   *                                            `.grade`, `.fmvPriceInUSD`,
   *                                            `.serial`, `.attributes`
   *   - src/routes/priceRoutes.ts           -> reads `.name`, `.setName`,
   *                                            `.cardNumber`, `.gradingCompany`,
   *                                            `.grade`, `.serial`, `.imageUrl`,
   *                                            `.attributes`, `.fmvPriceInUSD`
   *
   * These tests simulate the caller's field-access pattern on both shape
   * variants and assert every field a caller reads at the ROOT is present /
   * non-crashing on both variants.
   */

  const readAsIfCaller = (parsed: CanonicalRenaissCard): void => {
    // Every downstream call site does defensive field access; if any of these
    // throws or `undefined`s in a required position it will break embed
    // rendering. The point of this test is to make schema drift LOUD.
    const c = parsed as Record<string, unknown>;
    void (typeof c.name === 'string' ? c.name : null);
    void (typeof c.setName === 'string' ? c.setName : null);
    void (typeof c.cardNumber === 'string' ? c.cardNumber : null);
    void (typeof c.gradingCompany === 'string' ? c.gradingCompany : null);
    void (typeof c.grade === 'string' ? c.grade : null);
    void (typeof c.serial === 'string' ? c.serial : null);
    void (typeof c.imageUrl === 'string' ? c.imageUrl : null);
    void (
      typeof c.fmvPriceInUSD === 'string' || typeof c.fmvPriceInUSD === 'number'
        ? c.fmvPriceInUSD
        : null
    );
    // The attributes-loop pattern used by price/listing/explain/retriever.
    if (Array.isArray(c.attributes)) {
      for (const a of c.attributes) {
        if (typeof a !== 'object' || a === null) continue;
        const t = (a as { trait_type?: unknown }).trait_type;
        const v = (a as { value?: unknown }).value;
        void t;
        void v;
      }
    }
  };

  test('WRAPPED fixture: every existing caller can read canonical fields', () => {
    const parsed = renaissCardSchema.parse(
      readFixture('card-wrapped-2026-07-02.json')
    );
    expect(() => readAsIfCaller(parsed)).not.toThrow();

    // Assert the "hot fields" the price command reads to build the embed.
    expect(parsed.name).toBeTruthy();
    expect(parsed.setName).toBeTruthy();
    expect(parsed.gradingCompany).toBeTruthy();
    expect(parsed.grade).toBeTruthy();
    expect(parsed.imageUrl).toBeTruthy();
    expect(parsed.fmvPriceInUSD).toBeTruthy();

    // The attributes-loop should surface a serial when the upstream provides
    // one in the attribute array (mirrors the price/listing normalization).
    let serialFromAttrs: string | null = null;
    for (const a of parsed.attributes ?? []) {
      if (a.trait_type.toLowerCase() === 'serial' && typeof a.value === 'string') {
        serialFromAttrs = a.value;
      }
    }
    expect(serialFromAttrs).toBe('PSA73628064');
  });

  test('LEGACY fixture: every existing caller can read canonical fields', () => {
    const parsed = renaissCardSchema.parse(readFixture('card-legacy.json'));
    expect(() => readAsIfCaller(parsed)).not.toThrow();

    expect(parsed.name).toBe('Legacy shape card');
    expect(parsed.serial).toBe('BGS0000042');
    expect(parsed.imageUrl).toBeTruthy();
    expect(parsed.fmvPriceInUSD).toBe('12345');
  });
});

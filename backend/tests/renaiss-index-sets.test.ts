/**
 * Gap 3 tests: /v1/sets/{game}/{set} SetResponse schema + client wiring.
 *
 * Uses the live fixture captured 2026-07-03 from
 * https://api.renaissos.com/v1/sets/pokemon/pokemon-ex-unseen-forces so any
 * upstream drift fails loud rather than silently swallowing the change.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  setResponseSchema,
} from '../src/lib/renaiss-index/schemas.ts';
import { parseCardHref } from '../src/lib/renaiss-index/href.ts';

const readFixture = (name: string): unknown => {
  const path = resolve(
    process.cwd(),
    'tests',
    'fixtures',
    'renaiss-index',
    name
  );
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
};

describe('Gap 3: SetResponse schema (live fixture)', () => {
  test('setResponseSchema accepts /v1/sets/pokemon/pokemon-ex-unseen-forces fixture', () => {
    const fixture = readFixture('set-listing.json');
    const result = setResponseSchema.safeParse(fixture);
    if (!result.success) {
      console.error('setResponseSchema issues:', result.error.issues[0]);
    }
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.game).toBe('pokemon');
      expect(result.data.setSegment).toBe('pokemon-ex-unseen-forces');
      expect(result.data.cardCount).toBeGreaterThan(0);
      expect(result.data.cards.length).toBe(result.data.cardCount);
      const first = result.data.cards[0];
      expect(typeof first.name).toBe('string');
      expect(typeof first.gradeLabel).toBe('string');
      expect(typeof first.href).toBe('string');
    }
  });

  test('setResponseSchema rejects unknown game slug', () => {
    const bad = {
      game: 'yugioh',
      setName: 'x',
      setCode: null,
      setSegment: 'x',
      href: '/set/x',
      cardCount: 0,
      cards: [],
    };
    const r = setResponseSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  test('setResponseSchema requires setSegment as string', () => {
    const bad = {
      game: 'pokemon',
      setName: null,
      setCode: null,
      setSegment: null, // should be string
      href: '/set/x',
      cardCount: 0,
      cards: [],
    };
    expect(setResponseSchema.safeParse(bad).success).toBe(false);
  });

  test('setResponseSchema accepts empty cards array when cardCount is 0', () => {
    const good = {
      game: 'pokemon',
      setName: 'Empty Set',
      setCode: null,
      language: null,
      setSegment: 'empty',
      href: '/set/pokemon/empty',
      cardCount: 0,
      cards: [],
    };
    const r = setResponseSchema.safeParse(good);
    if (!r.success) console.error(r.error.issues[0]);
    expect(r.success).toBe(true);
  });

  test('every card href in the fixture is parseable into game/set/cardSlug', () => {
    const fixture = readFixture('set-listing.json') as { cards: Array<{ href: string }> };
    for (const card of fixture.cards) {
      const parsed = parseCardHref(card.href);
      expect(parsed).not.toBeNull();
      if (parsed !== null) {
        expect(parsed.game).toBe('pokemon');
        expect(parsed.setCode).toBe('pokemon-ex-unseen-forces');
        expect(typeof parsed.cardSlug).toBe('string');
        expect(parsed.cardSlug.length).toBeGreaterThan(0);
      }
    }
  });
});

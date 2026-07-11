/**
 * Real-corpus + file-17 §7.6 mandate tests.
 *
 * Covers:
 *   - assertGroundingChunks refuses with exact wording when chunks < 2.
 *   - appendDisclosureFooter enforces the mandated trailing line.
 *   - enforceCitations rejects paragraphs without a [source-N] marker.
 *   - CORPUS_SEEDS contains real, verifiable Medium URLs for the known-good
 *     hackathon query.
 *   - Every seed has a real, non-placeholder sourceUrl.
 *
 * Pure functions only: no DB, no Anthropic, no Discord.
 */

import { describe, test, expect } from 'bun:test';

import {
  AI_TRAILING_DISCLOSURE,
  INSUFFICIENT_GROUNDING_REFUSAL,
  MIN_GROUNDING_CHUNKS,
  appendDisclosureFooter,
  assertGroundingChunks,
  assertTrailingDisclosure,
  enforceCitations,
} from '../src/lib/anthropic/citation-guard.ts';
import { CORPUS_SEEDS, scoreCorpus } from '../src/lib/anthropic/corpus-seeds.ts';
import type { Source } from '../src/lib/anthropic/retriever.ts';

const isoNow = '2026-07-02T00:00:00.000Z';

const mkSource = (id: number, name = `src-${id}`): Source => ({
  id,
  name,
  url: `https://medium.com/@renaissxyz/${name}`,
  excerpt: `Excerpt for ${name}`.padEnd(200, '.'),
  fetchedAt: isoNow,
});

describe('assertGroundingChunks (file-17 §7.6 refusal wording)', () => {
  test('refuses when sources array is empty with the exact mandated message', () => {
    const r = assertGroundingChunks([]);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.refusal).toBe(
        'Insufficient grounding data for this card. Try /price for the raw stats.'
      );
      expect(r.refusal).toBe(INSUFFICIENT_GROUNDING_REFUSAL);
      expect(r.reason).toBe('insufficient-grounding');
    }
  });

  test('refuses when sources.length is 1', () => {
    const r = assertGroundingChunks([mkSource(1)]);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.refusal).toBe(INSUFFICIENT_GROUNDING_REFUSAL);
    }
  });

  test('passes when sources.length >= MIN_GROUNDING_CHUNKS (2)', () => {
    const r = assertGroundingChunks([mkSource(1), mkSource(2)]);
    expect(r.ok).toBe(true);
    expect(MIN_GROUNDING_CHUNKS).toBe(2);
  });

  test('rejects non-array (defensive)', () => {
    // @ts-expect-error - probing runtime defense
    const r = assertGroundingChunks(null);
    expect(r.ok).toBe(false);
  });
});

describe('appendDisclosureFooter enforces the exact trailing line', () => {
  test('appended text ends with the mandated disclosure', () => {
    const out = appendDisclosureFooter('Body [source-1].');
    expect(out.endsWith(AI_TRAILING_DISCLOSURE)).toBe(true);
    expect(AI_TRAILING_DISCLOSURE).toBe(
      'Experimental beta data. Not financial advice.'
    );
  });

  test('assertTrailingDisclosure passes on appended output', () => {
    const out = appendDisclosureFooter('Body [source-1].');
    expect(assertTrailingDisclosure(out).ok).toBe(true);
  });

  test('assertTrailingDisclosure fails when the trailing line is missing', () => {
    const r = assertTrailingDisclosure('Body without disclosure.');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing-trailing-disclosure');
  });

  test('idempotent when text already ends with the disclosure', () => {
    const once = appendDisclosureFooter('Body [source-1].');
    const twice = appendDisclosureFooter(once);
    expect(once).toBe(twice);
  });

  test('empty input still returns the disclosure', () => {
    const out = appendDisclosureFooter('');
    expect(out).toBe(AI_TRAILING_DISCLOSURE);
  });
});

describe('enforceCitations rejects uncited paragraphs', () => {
  const sources = [mkSource(1, 'a'), mkSource(2, 'b')];

  test('a paragraph with no [source-N] marker fails with uncited-claim', () => {
    const text =
      'First cited paragraph [source-1].\n\nSecond uncited paragraph with no marker.';
    const r = enforceCitations(text, sources);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('uncited-claim');
  });

  test('the trailing disclosure line is not counted as an uncited paragraph', () => {
    const text = `First cited paragraph [source-1].\n\nSecond cited paragraph [source-2].\n\n${AI_TRAILING_DISCLOSURE}`;
    const r = enforceCitations(text, sources);
    expect(r.ok).toBe(true);
    expect(r.citedSourceIds.sort()).toEqual([1, 2]);
  });
});

describe('CORPUS_SEEDS: real URLs only, no placeholders', () => {
  test('every seed has a real sourceUrl and non-placeholder tags', () => {
    expect(CORPUS_SEEDS.length).toBeGreaterThan(0);
    for (const s of CORPUS_SEEDS) {
      expect(typeof s.sourceUrl).toBe('string');
      expect(s.sourceUrl.length).toBeGreaterThan(0);
      expect(s.sourceUrl.startsWith('https://')).toBe(true);
      expect(s.tags).not.toContain('placeholder');
      expect(s.tags).not.toContain('todo');
      expect(s.id).not.toBe('placeholder');
    }
  });

  test('categories are exactly medium | industry | openapi', () => {
    const allowed = new Set(['medium', 'industry', 'openapi']);
    for (const s of CORPUS_SEEDS) {
      expect(allowed.has(s.category)).toBe(true);
    }
  });

  test('token estimate is present and positive on every seed', () => {
    for (const s of CORPUS_SEEDS) {
      expect(Number.isFinite(s.tokensEstimated)).toBe(true);
      expect(s.tokensEstimated).toBeGreaterThan(0);
    }
  });

  test('composite (sourceUrl, chunkIndex) is unique across seeds', () => {
    const seen = new Set<string>();
    for (const s of CORPUS_SEEDS) {
      const key = `${s.sourceUrl}#${s.chunkIndex}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('scoreCorpus surfaces real Renaiss Medium URLs for known-good queries', () => {
  test('"renaiss tech hackathon" returns the hackathon Medium post', () => {
    const hits = scoreCorpus('renaiss tech hackathon', 3);
    expect(hits.length).toBeGreaterThan(0);
    const urls = hits.map((h) => h.sourceUrl);
    const hitsMedium = urls.some((u) =>
      u.startsWith('https://medium.com/@renaissxyz/renaiss-tech-hackathon-s1')
    );
    expect(hitsMedium).toBe(true);
  });

  test('"cert graded index api" returns an OpenAPI or Index chunk', () => {
    const hits = scoreCorpus('cert graded index api', 3);
    expect(hits.length).toBeGreaterThan(0);
    const anyIndex = hits.some(
      (h) => h.category === 'openapi' || h.sourceUrl.includes('api.renaissos.com')
    );
    expect(anyIndex).toBe(true);
  });

  test('"superliquid liquidity points" returns the Superliquid Medium post', () => {
    const hits = scoreCorpus('superliquid liquidity points', 3);
    expect(hits.length).toBeGreaterThan(0);
    const matched = hits.some((h) =>
      h.sourceUrl.startsWith(
        'https://medium.com/@renaissxyz/superliquid-beta-2-0'
      )
    );
    expect(matched).toBe(true);
  });

  test('empty query returns empty result (no accidental placeholder leak)', () => {
    const hits = scoreCorpus('', 3);
    expect(hits.length).toBe(0);
  });
});

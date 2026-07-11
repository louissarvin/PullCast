/**
 * Citation guard tests. Covers the post-processor that enforces the
 * `[source-N]` citation mandate on every AI response paragraph.
 *
 * Pure functions only: no DB, no Anthropic, no Discord.
 */

import { describe, test, expect } from 'bun:test';

import {
  AI_TRAILING_DISCLOSURE,
  appendDisclosureFooter,
  enforceCitations,
  stripUnreferencedCitations,
} from '../src/lib/anthropic/citation-guard.ts';
import type { Source } from '../src/lib/anthropic/retriever.ts';

const fixedDate = '2026-06-30T00:00:00.000Z';

const makeSource = (id: number, name: string): Source => ({
  id,
  name,
  url: `https://api.renaiss.xyz/v0/${name}`,
  excerpt: `Excerpt for ${name}`.padEnd(200, '.'),
  confidence: 'high',
  fetchedAt: fixedDate,
});

const sources: Source[] = [makeSource(1, 'a'), makeSource(2, 'b')];

describe('enforceCitations', () => {
  test('single cited paragraph passes', () => {
    const text = 'The card has graded data on file [source-1].';
    const result = enforceCitations(text, sources);
    expect(result.ok).toBe(true);
    expect(result.citedSourceIds).toEqual([1]);
  });

  test('paragraph missing citation fails with uncited-claim', () => {
    const text = 'This card is desirable because it is rare.';
    const result = enforceCitations(text, sources);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-citations');
  });

  test('multi-paragraph: last paragraph uncited returns uncited-claim', () => {
    const text =
      'First paragraph with a citation [source-1].\n\nSecond paragraph has none.';
    const result = enforceCitations(text, sources);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('uncited-claim');
  });

  test('hallucinated source-99 alone fails (not in allowed set)', () => {
    const text = 'Hallucinated claim [source-99].';
    const result = enforceCitations(text, sources);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('uncited-claim');
  });

  test('empty input returns empty-response refusal', () => {
    const result = enforceCitations('', sources);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty-response');
  });

  test('whitespace-only input refused', () => {
    const result = enforceCitations('   \n\n  \n', sources);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty-response');
  });

  test('no-sources case is refused with no-sources', () => {
    const result = enforceCitations('Cited text [source-1].', []);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-sources');
  });

  test('two valid paragraphs each cited returns ok with both ids', () => {
    const text =
      'Paragraph A claim [source-1].\n\nParagraph B claim [source-2].';
    const result = enforceCitations(text, sources);
    expect(result.ok).toBe(true);
    expect(result.citedSourceIds).toEqual([1, 2]);
  });
});

describe('stripUnreferencedCitations', () => {
  test('hallucinated [source-99] is stripped', () => {
    const out = stripUnreferencedCitations('Claim [source-99].', sources);
    expect(out).toBe('Claim .');
  });

  test('valid [source-1] is preserved', () => {
    const out = stripUnreferencedCitations('Claim [source-1].', sources);
    expect(out).toBe('Claim [source-1].');
  });

  test('mixed valid and hallucinated: hallucinated stripped, valid kept', () => {
    const out = stripUnreferencedCitations(
      'Claim [source-1] and [source-9].',
      sources
    );
    expect(out).toBe('Claim [source-1] and .');
  });

  test('idempotent: running twice returns same result', () => {
    const once = stripUnreferencedCitations(
      'Claim [source-1] and [source-9].',
      sources
    );
    const twice = stripUnreferencedCitations(once, sources);
    expect(once).toBe(twice);
  });
});

describe('integration: strip then enforce', () => {
  test('paragraph with both valid and hallucinated keeps the valid citation and passes', () => {
    const text = 'Mixed paragraph [source-1] and [source-99].';
    const stripped = stripUnreferencedCitations(text, sources);
    const result = enforceCitations(stripped, sources);
    expect(result.ok).toBe(true);
    expect(result.citedSourceIds).toEqual([1]);
  });

  test('paragraph cited only with hallucinated source becomes uncited after strip', () => {
    const text = 'Hallucinated only [source-99].';
    const stripped = stripUnreferencedCitations(text, sources);
    const result = enforceCitations(stripped, sources);
    expect(result.ok).toBe(false);
  });
});

describe('appendDisclosureFooter', () => {
  test('adds the mandated trailing disclosure on its own block at the end', () => {
    const text = 'Some answer body.';
    const out = appendDisclosureFooter(text);
    expect(out.endsWith(AI_TRAILING_DISCLOSURE)).toBe(true);
    expect(out).toContain('\n\n' + AI_TRAILING_DISCLOSURE);
  });

  test('idempotent: does not append a second copy', () => {
    const once = appendDisclosureFooter('Body.');
    const twice = appendDisclosureFooter(once);
    expect(once).toBe(twice);
  });

  test('empty input still returns the disclosure', () => {
    const out = appendDisclosureFooter('');
    expect(out).toContain(AI_TRAILING_DISCLOSURE);
  });
});

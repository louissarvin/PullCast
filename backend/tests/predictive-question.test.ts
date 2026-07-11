/**
 * Predictive-question regex tests.
 *
 * SOURCE OF TRUTH: `src/lib/anthropic/explain.ts` PREDICTIVE_RX. That regex
 * is not exported, so this test file MIRRORS it verbatim. If the regex in
 * explain.ts changes, this mirror MUST be updated to match.
 *
 * The regex fires BEFORE any Anthropic API call. A miss here means the model
 * is asked to make a price prediction — the single biggest AI safety risk per
 * the architecture risk register.
 */

import { describe, test, expect } from 'bun:test';

// MIRRORED from src/lib/anthropic/explain.ts:60 — keep in sync.
const PREDICTIVE_RX =
  /(should\s+i\s+(buy|sell|hold))|(will\s+.+\s+go\s+(up|down))|(price\s+prediction)|(moonshot)|(guarantee)/i;

const isPredictive = (q: string): boolean => PREDICTIVE_RX.test(q);

describe('PREDICTIVE_RX positive matches (must refuse)', () => {
  test('"should i buy this card?" matches', () => {
    expect(isPredictive('should i buy this card?')).toBe(true);
  });

  test('"Should I sell my PSA 10?" matches (case insensitive)', () => {
    expect(isPredictive('Should I sell my PSA 10?')).toBe(true);
  });

  test('"should i hold" matches', () => {
    expect(isPredictive('should i hold this for a year?')).toBe(true);
  });

  test('"will this card go up?" matches', () => {
    expect(isPredictive('will this card go up?')).toBe(true);
  });

  test('"will the price go down soon?" matches', () => {
    expect(isPredictive('will the price go down soon?')).toBe(true);
  });

  test('"is this a moonshot?" matches', () => {
    expect(isPredictive('is this a moonshot?')).toBe(true);
  });

  test('"price prediction" matches', () => {
    expect(isPredictive('what is your price prediction for this card?')).toBe(
      true
    );
  });

  test('"guarantee" matches', () => {
    expect(isPredictive('can you guarantee this will be worth more?')).toBe(
      true
    );
  });
});

describe('PREDICTIVE_RX negative matches (must allow)', () => {
  test('"What does PSA grading mean for this card?" allowed', () => {
    expect(isPredictive('What does PSA grading mean for this card?')).toBe(
      false
    );
  });

  test('"Explain why this card is rare" allowed', () => {
    expect(isPredictive('Explain why this card is rare')).toBe(false);
  });

  test('"What is the FMV of this cert?" allowed', () => {
    expect(isPredictive('What is the FMV of this cert?')).toBe(false);
  });

  test('"What set is this card from?" allowed', () => {
    expect(isPredictive('What set is this card from?')).toBe(false);
  });

  test('"Tell me about the grading company" allowed', () => {
    expect(isPredictive('Tell me about the grading company')).toBe(false);
  });

  test('bare word "moon" alone does NOT match (regex requires "moonshot")', () => {
    // Documented in d6-ai-progress.md: "moon" by itself does not trip the
    // regex. This is a known partial-coverage gap.
    expect(isPredictive('to the moon')).toBe(false);
  });
});

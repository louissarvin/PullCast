/**
 * Disclosure module tests. The disclosure constants are the canonical safety
 * markers required on every Discord embed, share card, and AI response. These
 * tests assert the invariants that the rest of the codebase depends on.
 */

import { describe, test, expect } from 'bun:test';

import {
  DISCLOSURE_TEXT_FULL,
  DISCLOSURE_TEXT_SHORT,
  DISCLOSURE_WATERMARK,
  attachDisclosure,
  discordEmbedFooter,
  getSourceCitationBlock,
} from '../src/lib/disclosure/index.ts';

describe('disclosure constants', () => {
  test('DISCLOSURE_TEXT_FULL is a non-empty string', () => {
    expect(typeof DISCLOSURE_TEXT_FULL).toBe('string');
    expect(DISCLOSURE_TEXT_FULL.length).toBeGreaterThan(0);
  });

  test('DISCLOSURE_TEXT_SHORT is a non-empty string', () => {
    expect(typeof DISCLOSURE_TEXT_SHORT).toBe('string');
    expect(DISCLOSURE_TEXT_SHORT.length).toBeGreaterThan(0);
  });

  test('both disclosure constants include "Not financial advice"', () => {
    expect(DISCLOSURE_TEXT_FULL).toContain('Not financial advice');
    expect(DISCLOSURE_TEXT_SHORT).toContain('Not financial advice');
  });

  test('DISCLOSURE_WATERMARK is a non-empty string', () => {
    expect(typeof DISCLOSURE_WATERMARK).toBe('string');
    expect(DISCLOSURE_WATERMARK.length).toBeGreaterThan(0);
  });
});

describe('attachDisclosure', () => {
  test('returns object with _disclosure field', () => {
    const input = { foo: 1 };
    const out = attachDisclosure(input);
    expect(out.foo).toBe(1);
    expect(out._disclosure).toBe(DISCLOSURE_TEXT_FULL);
  });

  test('does not mutate the input object', () => {
    const input: { foo: number; _disclosure?: string } = { foo: 1 };
    attachDisclosure(input);
    expect(input._disclosure).toBeUndefined();
  });
});

describe('discordEmbedFooter', () => {
  test('returns object with text containing the full disclosure', () => {
    const footer = discordEmbedFooter();
    expect(typeof footer.text).toBe('string');
    expect(footer.text).toContain('Not financial advice');
  });
});

describe('getSourceCitationBlock', () => {
  test('returns a string with [source-1] and [source-2] tokens', () => {
    const block = getSourceCitationBlock([
      { name: 'a', url: 'http://x' },
      { name: 'b', url: 'http://y' },
    ]);
    expect(block).toContain('[source-1]');
    expect(block).toContain('[source-2]');
    expect(block).toContain('a');
    expect(block).toContain('http://x');
  });

  test('empty source list falls back to the short disclosure', () => {
    const block = getSourceCitationBlock([]);
    expect(block).toBe(DISCLOSURE_TEXT_SHORT);
  });
});

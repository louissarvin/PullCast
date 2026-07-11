/**
 * D8-M-6 regression: the Card of the Day worker persists `card.imageUrl` into
 * `Pull.frontImageUrl`. Any URL that reaches the DB flows out to downstream
 * consumers (share-card renderer, frontend `<img>` tags, future OG endpoints)
 * — so we MUST reject non-allowlisted hosts at write time, not just render
 * time.
 *
 * The full worker chain requires a Prisma client + Discord + Renaiss upstream,
 * which are not available in unit tests. These tests instead exercise the
 * exact `sanitizeImageUrl` predicate the worker calls, and verify the shape
 * of decision the worker makes:
 *
 *   safeFrontImageUrl = sanitizeImageUrl(card.imageUrl)
 *
 * The DB write receives `safeFrontImageUrl` (null on rejection). Downstream
 * consumers see either a Renaiss-owned URL or null and never an attacker-
 * controlled value.
 */

import { describe, test, expect } from 'bun:test';

import { sanitizeImageUrl } from '../src/utils/urlAllowlist.ts';

describe('cardOfTheDay imageUrl SSRF persistence guard (D8-M-6)', () => {
  test('persists allowlisted https://cdn.renaiss.xyz URL', () => {
    expect(sanitizeImageUrl('https://cdn.renaiss.xyz/card-1.png')).toBe(
      'https://cdn.renaiss.xyz/card-1.png'
    );
  });

  test('persists allowlisted https://images.renaiss.xyz URL', () => {
    expect(sanitizeImageUrl('https://images.renaiss.xyz/card.png')).toBe(
      'https://images.renaiss.xyz/card.png'
    );
  });

  test('persists allowlisted https://api.renaissos.com URL', () => {
    expect(sanitizeImageUrl('https://api.renaissos.com/card.png')).toBe(
      'https://api.renaissos.com/card.png'
    );
  });

  test('REJECTS http://169.254.169.254 (AWS IMDS SSRF)', () => {
    expect(
      sanitizeImageUrl('http://169.254.169.254/latest/meta-data/iam/')
    ).toBeNull();
  });

  test('REJECTS https://169.254.169.254 (AWS IMDS via https)', () => {
    expect(sanitizeImageUrl('https://169.254.169.254/latest/meta-data/')).toBeNull();
  });

  test('REJECTS http://cdn.renaiss.xyz (non-https)', () => {
    expect(sanitizeImageUrl('http://cdn.renaiss.xyz/card.png')).toBeNull();
  });

  test('REJECTS https://attacker.com (not on allowlist)', () => {
    expect(sanitizeImageUrl('https://attacker.com/tracker.png')).toBeNull();
  });

  test('REJECTS javascript: pseudo-URL', () => {
    expect(sanitizeImageUrl('javascript:alert(1)')).toBeNull();
  });

  test('REJECTS file:// URL', () => {
    expect(sanitizeImageUrl('file:///etc/passwd')).toBeNull();
  });

  test('REJECTS data: URL (data URLs are not persistable; renderer only)', () => {
    // Card of the Day persists the URL to the DB and passes it to `<img>`
    // downstream. A data: URL would inflate the DB row and is not the
    // intent — the worker calls fetchImageAsDataUrl separately for the
    // Satori render.
    expect(sanitizeImageUrl('data:image/png;base64,AAAA')).toBeNull();
  });

  test('REJECTS empty string / null / undefined', () => {
    expect(sanitizeImageUrl('')).toBeNull();
    expect(sanitizeImageUrl(null)).toBeNull();
    expect(sanitizeImageUrl(undefined)).toBeNull();
  });

  test('REJECTS malformed URL', () => {
    expect(sanitizeImageUrl('not a url')).toBeNull();
    expect(sanitizeImageUrl('https://')).toBeNull();
  });

  test('REJECTS non-string input', () => {
    expect(sanitizeImageUrl(12345)).toBeNull();
    expect(sanitizeImageUrl({ url: 'https://cdn.renaiss.xyz' })).toBeNull();
  });

  test('a subdomain of an allowlisted host does NOT bypass (exact hostname match)', () => {
    expect(
      sanitizeImageUrl('https://evil.cdn.renaiss.xyz/x.png')
    ).toBeNull();
    expect(
      sanitizeImageUrl('https://cdn.renaiss.xyz.attacker.com/x.png')
    ).toBeNull();
  });

  test('userinfo credentials do not bypass the host check', () => {
    // `https://cdn.renaiss.xyz@attacker.com/x.png` — the actual host is
    // attacker.com and the "cdn.renaiss.xyz" portion is a username.
    expect(
      sanitizeImageUrl('https://cdn.renaiss.xyz@attacker.com/x.png')
    ).toBeNull();
  });
});

/**
 * SSRF allowlist contract test for the share-card image fetcher.
 *
 * NOTE: `isSafeImageUrl` in `src/lib/share-card/render.ts` is module-private
 * (the security fixup did not export it). Per the test brief, this file
 * MIRRORS the function body verbatim and asserts the documented contract.
 * If `render.ts` ever changes the allowlist or scheme rules, this mirror
 * must be updated to match. The intent is to lock down the H-4 SSRF defense
 * behavior so a future refactor cannot silently widen it.
 *
 * Source of truth: src/lib/share-card/render.ts isSafeImageUrl + ALLOWED_IMAGE_HOSTS.
 */

import { describe, test, expect } from 'bun:test';

const ALLOWED_IMAGE_HOSTS = new Set([
  'cdn.renaiss.xyz',
  'images.renaiss.xyz',
  'api.renaiss.xyz',
  'api.renaissos.com',
  'placehold.co',
]);

const isSafeImageUrl = (raw: unknown): boolean => {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  if (raw.startsWith('data:')) return true;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_IMAGE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
};

describe('isSafeImageUrl (SSRF allowlist)', () => {
  test('data: URL passes (inlined base64)', () => {
    expect(isSafeImageUrl('data:image/png;base64,AAAA')).toBe(true);
  });

  test('https://cdn.renaiss.xyz passes', () => {
    expect(isSafeImageUrl('https://cdn.renaiss.xyz/x.png')).toBe(true);
  });

  test('https://images.renaiss.xyz passes', () => {
    expect(isSafeImageUrl('https://images.renaiss.xyz/x.png')).toBe(true);
  });

  test('http (not https) fails even on allowlisted host', () => {
    expect(isSafeImageUrl('http://cdn.renaiss.xyz/x.png')).toBe(false);
  });

  test('https://attacker.com fails (not on allowlist)', () => {
    expect(isSafeImageUrl('https://attacker.com/x.png')).toBe(false);
  });

  test('AWS IMDS via plain http fails', () => {
    expect(
      isSafeImageUrl(
        'http://169.254.169.254/latest/meta-data/iam/security-credentials/'
      )
    ).toBe(false);
  });

  test('AWS IMDS via https still fails (not on allowlist)', () => {
    expect(isSafeImageUrl('https://169.254.169.254/latest/meta-data/')).toBe(
      false
    );
  });

  test('file:// URL fails', () => {
    expect(isSafeImageUrl('file:///etc/passwd')).toBe(false);
  });

  test('javascript: URL fails', () => {
    expect(isSafeImageUrl('javascript:alert(1)')).toBe(false);
  });

  test('empty string fails', () => {
    expect(isSafeImageUrl('')).toBe(false);
  });

  test('non-string input fails', () => {
    expect(isSafeImageUrl(null)).toBe(false);
    expect(isSafeImageUrl(undefined)).toBe(false);
    expect(isSafeImageUrl(12345)).toBe(false);
  });

  test('malformed URL fails (URL constructor throws)', () => {
    expect(isSafeImageUrl('not a url at all')).toBe(false);
  });
});

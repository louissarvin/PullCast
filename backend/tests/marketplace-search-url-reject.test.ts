/**
 * D8-M-3 (security): the `/api/marketplace?search=` parameter is forwarded to
 * the upstream Renaiss `/v0/marketplace` proxy. Even though the outbound URL is
 * a constant today, a future refactor that reads `search` and fans out (e.g.
 * an image enricher) would inherit an SSRF surface unless we reject URL-like
 * values at the boundary here.
 *
 * The guard rejects:
 *   - http://... / https://...  (scheme+authority form)
 *   - //authority               (protocol-relative form)
 *   - data: / javascript: / file:   (non-http schemes)
 *   - control chars \n \r \0  (log / header smuggling defense)
 *
 * The guard lives in `src/utils/marketplaceSearchGuard.ts` (zero deps, no DB
 * import) so this test exercises it without booting the whole route module
 * (which transitively imports Prisma).
 */

import { describe, test, expect } from 'bun:test';

import { isUrlLikeSearchValue } from '../src/utils/marketplaceSearchGuard.ts';

describe('marketplace search — URL rejection (D8-M-3)', () => {
  test('rejects a raw http:// URL', () => {
    expect(isUrlLikeSearchValue('http://169.254.169.254/meta')).toBe(true);
  });

  test('rejects a raw https:// URL', () => {
    expect(isUrlLikeSearchValue('https://attacker.example/x')).toBe(true);
  });

  test('rejects protocol-relative URLs starting with //', () => {
    expect(isUrlLikeSearchValue('//attacker.example/x')).toBe(true);
  });

  test('rejects data: URIs', () => {
    expect(isUrlLikeSearchValue('data:text/html;base64,PHNjcmlwdD4=')).toBe(true);
  });

  test('rejects javascript: URIs', () => {
    expect(isUrlLikeSearchValue('javascript:alert(1)')).toBe(true);
  });

  test('rejects file: URIs', () => {
    expect(isUrlLikeSearchValue('file:///etc/passwd')).toBe(true);
  });

  test('rejects uppercase scheme variants (case-insensitive)', () => {
    expect(isUrlLikeSearchValue('HTTP://evil.com')).toBe(true);
    expect(isUrlLikeSearchValue('Https://evil.com')).toBe(true);
    expect(isUrlLikeSearchValue('JAVASCRIPT:1')).toBe(true);
  });

  test('rejects newline / CR / NUL smuggling attempts', () => {
    expect(isUrlLikeSearchValue('char\nizard')).toBe(true);
    expect(isUrlLikeSearchValue('char\rizard')).toBe(true);
    expect(isUrlLikeSearchValue('char\0izard')).toBe(true);
    expect(isUrlLikeSearchValue('char\r\nSet-Cookie: x=y')).toBe(true);
  });

  test('accepts legitimate card names', () => {
    expect(isUrlLikeSearchValue('charizard')).toBe(false);
    expect(isUrlLikeSearchValue('Charizard VMAX')).toBe(false);
  });

  test('accepts names with dashes and spaces', () => {
    expect(isUrlLikeSearchValue('One Piece Card Game')).toBe(false);
    expect(isUrlLikeSearchValue('poke-set-2023')).toBe(false);
  });

  test('accepts names containing colons but not scheme form', () => {
    // "Pikachu: shiny" is a legit name pattern. It contains ':' but not the
    // scheme structure. Confirms we did not over-block colon.
    expect(isUrlLikeSearchValue('Pikachu: shiny')).toBe(false);
    expect(isUrlLikeSearchValue('foo:bar')).toBe(false);
  });

  test('accepts tab and space (only \\n \\r \\0 are control-blocked)', () => {
    // Tabs and normal spaces are legitimate; only line terminators and NUL
    // are attacker-controllable smuggling primitives.
    expect(isUrlLikeSearchValue('char\tizard')).toBe(false);
    expect(isUrlLikeSearchValue('char izard')).toBe(false);
  });
});

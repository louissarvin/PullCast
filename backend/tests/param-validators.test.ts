/**
 * Param validator tests. These validators run on every public route and shut
 * down the entire injection surface at the regex layer, so the contract here
 * must not regress.
 */

import { describe, test, expect } from 'bun:test';

import {
  validateWalletAddress,
  validateTokenId,
  validateCert,
  validatePullId,
  validateCursor,
  validateLimit,
} from '../src/utils/paramValidators.ts';

describe('validateWalletAddress', () => {
  test('valid lowercase 0x + 40 hex passes', () => {
    const w = '0x' + 'a'.repeat(40);
    expect(validateWalletAddress(w)).toBe(w);
  });

  test('uppercase hex is normalized to lowercase', () => {
    const w = '0x' + 'AB12CD'.padEnd(40, 'F');
    const out = validateWalletAddress(w);
    expect(out).toBe(w.toLowerCase());
  });

  test('39 hex chars fails', () => {
    expect(validateWalletAddress('0x' + 'a'.repeat(39))).toBeNull();
  });

  test('missing 0x prefix fails', () => {
    expect(validateWalletAddress('a'.repeat(40))).toBeNull();
  });

  test('non-string fails', () => {
    expect(validateWalletAddress(123)).toBeNull();
    expect(validateWalletAddress(null)).toBeNull();
    expect(validateWalletAddress(undefined)).toBeNull();
  });
});

describe('validateTokenId', () => {
  test('short numeric id passes', () => {
    expect(validateTokenId('12345')).toBe('12345');
  });

  test('alphanumeric fails', () => {
    expect(validateTokenId('12345abc')).toBeNull();
  });

  test('78 digit uint256 max passes', () => {
    const big = '9'.repeat(78);
    expect(validateTokenId(big)).toBe(big);
  });

  test('79 digits fails', () => {
    expect(validateTokenId('9'.repeat(79))).toBeNull();
  });

  test('empty string fails', () => {
    expect(validateTokenId('')).toBeNull();
  });
});

describe('validateCert', () => {
  test('PSA + 8 digits passes, uppercased', () => {
    expect(validateCert('PSA73628064')).toBe('PSA73628064');
  });

  test('lowercase psa passes and uppercases output', () => {
    expect(validateCert('psa73628064')).toBe('PSA73628064');
  });

  test('PSA + letters fails', () => {
    expect(validateCert('PSAabcdef')).toBeNull();
  });

  test('5 digit numeric tail fails (too short)', () => {
    expect(validateCert('PSA12345')).toBeNull();
  });

  test('BGS, CGC, SGC prefixes accepted', () => {
    expect(validateCert('BGS123456')).toBe('BGS123456');
    expect(validateCert('CGC123456')).toBe('CGC123456');
    expect(validateCert('SGC123456')).toBe('SGC123456');
  });

  test('unknown prefix rejected', () => {
    expect(validateCert('XYZ123456')).toBeNull();
  });
});

describe('validatePullId', () => {
  test('24 lowercase alnum passes', () => {
    const id = 'a'.repeat(24);
    expect(validatePullId(id)).toBe(id);
  });

  test('30 lowercase alnum passes', () => {
    const id = 'b'.repeat(30);
    expect(validatePullId(id)).toBe(id);
  });

  test('23 chars fails (too short)', () => {
    expect(validatePullId('a'.repeat(23))).toBeNull();
  });

  test('31 chars fails (too long)', () => {
    expect(validatePullId('a'.repeat(31))).toBeNull();
  });

  test('uppercase is currently ALLOWED (audit L-6 deferred fix)', () => {
    // Per the security audit L-6: validatePullId regex uses /i flag, so
    // uppercase still passes. This test documents the current behavior; if
    // L-6 is later tightened to lowercase-only, this expectation flips to
    // toBeNull and the test name updates.
    const id = 'A'.repeat(24);
    expect(validatePullId(id)).toBe(id);
  });

  test('special characters rejected', () => {
    expect(validatePullId('a'.repeat(23) + '-')).toBeNull();
  });
});

describe('validateLimit', () => {
  test('accepts 1 through 200 in [1, 200] range', () => {
    expect(validateLimit('1', 50, 1, 200)).toBe(1);
    expect(validateLimit('200', 50, 1, 200)).toBe(200);
    expect(validateLimit('50', 50, 1, 200)).toBe(50);
  });

  test('rejects 0 and 201 in [1, 200] range', () => {
    expect(validateLimit('0', 50, 1, 200)).toBeNull();
    expect(validateLimit('201', 50, 1, 200)).toBeNull();
  });

  test('undefined returns the default', () => {
    expect(validateLimit(undefined, 50, 1, 200)).toBe(50);
  });

  test('empty string returns the default', () => {
    expect(validateLimit('', 50, 1, 200)).toBe(50);
  });

  test('garbage returns null', () => {
    expect(validateLimit('not a number', 50, 1, 200)).toBeNull();
  });

  test('floors floats', () => {
    expect(validateLimit('50.9', 50, 1, 200)).toBe(50);
  });
});

describe('validateCursor', () => {
  test('valid 24-char cuid passes', () => {
    const c = 'a'.repeat(24);
    expect(validateCursor(c)).toBe(c);
  });

  test('undefined returns undefined', () => {
    expect(validateCursor(undefined)).toBeUndefined();
  });

  test('null returns undefined', () => {
    expect(validateCursor(null)).toBeUndefined();
  });

  test('empty string returns undefined (treated as no cursor)', () => {
    expect(validateCursor('')).toBeUndefined();
  });

  test('whitespace-only string returns undefined', () => {
    expect(validateCursor('   ')).toBeUndefined();
  });

  test('malformed cursor returns null', () => {
    expect(validateCursor('short')).toBeNull();
  });
});

/**
 * D8-M-7 regression: `src/lib/ethers/provider.ts` MUST NOT log the full
 * `BSC_RPC_PRIMARY` / `BSC_RPC_FALLBACK` URL. If an operator has swapped in
 * a paid provider (Ankr, QuickNode, Alchemy), the API key is embedded in the
 * pathname and the log line would leak it to every log-aggregation SaaS.
 *
 * This test exercises the pure `redactUrlForLog` helper the provider uses,
 * and asserts:
 *   - the host is preserved (operators need to identify the upstream)
 *   - the path, query string, hash, and userinfo credentials are stripped
 *   - malformed input never throws; it returns `[invalid-url]`
 */

import { describe, test, expect } from 'bun:test';

import { redactUrlForLog } from '../src/utils/urlAllowlist.ts';

describe('redactUrlForLog (D8-M-7)', () => {
  test('preserves protocol + host for a bare public URL', () => {
    const redacted = redactUrlForLog('https://bsc-dataseed.publicnode.com');
    expect(redacted).toContain('bsc-dataseed.publicnode.com');
    expect(redacted).toContain('https:');
  });

  test('strips Ankr-style API key from pathname', () => {
    const url = 'https://rpc.ankr.com/bsc/1234567890abcdefdeadbeef';
    const redacted = redactUrlForLog(url);
    expect(redacted).toContain('rpc.ankr.com');
    expect(redacted).not.toContain('1234567890abcdefdeadbeef');
    expect(redacted).not.toContain('/bsc/');
  });

  test('strips Alchemy v2 API key from pathname', () => {
    const url = 'https://bsc-dataseed.alchemy.com/v2/SECRET_KEY_HERE_1234';
    const redacted = redactUrlForLog(url);
    expect(redacted).toContain('bsc-dataseed.alchemy.com');
    expect(redacted).not.toContain('SECRET_KEY_HERE_1234');
    expect(redacted).not.toContain('/v2/');
  });

  test('strips QuickNode subdomain-embedded credentials from pathname', () => {
    const url =
      'https://my-node.quicknode.pro/API_TOKEN_XYZ_ABCDEFG/bsc-mainnet';
    const redacted = redactUrlForLog(url);
    expect(redacted).toContain('my-node.quicknode.pro');
    expect(redacted).not.toContain('API_TOKEN_XYZ_ABCDEFG');
    expect(redacted).not.toContain('bsc-mainnet');
  });

  test('strips query string secrets', () => {
    const url = 'https://bsc.example.com/?apikey=SUPERSECRET&x=y';
    const redacted = redactUrlForLog(url);
    expect(redacted).not.toContain('SUPERSECRET');
    expect(redacted).not.toContain('apikey');
    expect(redacted).toContain('bsc.example.com');
  });

  test('strips URL fragment', () => {
    const url = 'https://bsc.example.com/#token=abc';
    const redacted = redactUrlForLog(url);
    expect(redacted).not.toContain('abc');
    expect(redacted).not.toContain('#');
  });

  test('strips basic-auth userinfo credentials', () => {
    const url = 'https://user:SECRET_PASSWORD@bsc.example.com/rpc';
    const redacted = redactUrlForLog(url);
    expect(redacted).not.toContain('SECRET_PASSWORD');
    expect(redacted).not.toContain('user');
    expect(redacted).toContain('bsc.example.com');
  });

  test('preserves non-default port', () => {
    const url = 'https://bsc.example.com:8545/rpc/secret';
    const redacted = redactUrlForLog(url);
    expect(redacted).toContain('bsc.example.com:8545');
    expect(redacted).not.toContain('secret');
  });

  test('returns [invalid-url] on malformed input', () => {
    expect(redactUrlForLog('not a url')).toBe('[invalid-url]');
    expect(redactUrlForLog('')).toBe('[invalid-url]');
    expect(redactUrlForLog(null)).toBe('[invalid-url]');
    expect(redactUrlForLog(undefined)).toBe('[invalid-url]');
    expect(redactUrlForLog(12345)).toBe('[invalid-url]');
  });

  test('does not throw on any input', () => {
    expect(() => redactUrlForLog('data:text/html,<script>alert(1)</script>')).not.toThrow();
  });
});

describe('provider.ts init log line (D8-M-7 integration)', () => {
  test('provider init log does NOT contain a full URL with API-key-shaped pathname', async () => {
    // Intercept console.log and drive the provider init once. We inject
    // fake env-shaped RPC URLs via the module we import, but the actual
    // BSC_RPC_PRIMARY / BSC_RPC_FALLBACK are read from env at import time.
    // Since main-config reads process.env at module load, we cannot re-read
    // it in this test; instead we verify the redactor is applied by asserting
    // the log line for whatever URL the config resolved to matches the
    // `${protocol}//${host}/…` shape.
    const captured: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => {
      if (typeof msg === 'string') captured.push(msg);
    };
    try {
      const { getBscProvider, __resetBscProviderForTests } = await import(
        '../src/lib/ethers/provider.ts'
      );
      __resetBscProviderForTests();
      getBscProvider();
    } finally {
      console.log = originalLog;
    }

    const initLine = captured.find((l) => l.includes('provider initialized'));
    expect(initLine).toBeDefined();
    if (!initLine) return;

    // Expect the redacted shape: `primary=https://<host>/…` and
    // `fallback=https://<host>/…`. Regex asserts that the URL portion after
    // `primary=` and `fallback=` ends at `/…` and does NOT include a longer
    // path.
    const primaryMatch = initLine.match(/primary=(\S+)/);
    const fallbackMatch = initLine.match(/fallback=(\S+)/);
    expect(primaryMatch).not.toBeNull();
    expect(fallbackMatch).not.toBeNull();
    // Redacted form ends with `/…`. Either that or `[invalid-url]` for env
    // that resolved to a bad string.
    expect(primaryMatch?.[1].endsWith('/…') || primaryMatch?.[1] === '[invalid-url]').toBe(true);
    expect(fallbackMatch?.[1].endsWith('/…') || fallbackMatch?.[1] === '[invalid-url]').toBe(true);
  });
});

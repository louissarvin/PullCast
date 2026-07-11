/**
 * Envelope helper tests. Every REST route emits `buildEnvelope(...)` output,
 * so this test locks the shape contract that downstream clients, the CLI, and
 * the Claude Code plugin depend on.
 *
 * Covered:
 *  - Shape: success/error/data/sources/warnings/generated_at with correct types.
 *  - `data` inherits the `_disclosure` marker (legacy client contract).
 *  - `warnings` always includes BETA when includeBeta is not overridden.
 *  - Custom sources / warnings compose without dropping BETA.
 *  - `generated_at` is a valid ISO 8601 timestamp.
 *  - Non-object data (arrays / primitives / null) does NOT get `_disclosure`
 *    attached (would break array-consumer contracts).
 *  - BETA_WARNING has the exact copy from file 17 §7.
 *  - Standard source constants have both label and url.
 */

import { describe, test, expect } from 'bun:test';

import {
  BETA_WARNING,
  SOURCE_BSC_ORDERBOOK,
  SOURCE_BSC_TVM,
  SOURCE_RENAISS_INDEX,
  SOURCE_RENAISS_MAIN,
  buildEnvelope,
} from '../src/utils/envelope.ts';

describe('buildEnvelope — shape contract', () => {
  test('emits {success, error, data, sources, warnings, generated_at}', () => {
    const env = buildEnvelope({ hello: 'world' });
    expect(env.success).toBe(true);
    expect(env.error).toBeNull();
    expect(typeof env.data).toBe('object');
    expect(Array.isArray(env.sources)).toBe(true);
    expect(Array.isArray(env.warnings)).toBe(true);
    expect(typeof env.generated_at).toBe('string');
  });

  test('generated_at is a valid ISO 8601 timestamp', () => {
    const env = buildEnvelope({ x: 1 });
    // Round-trip through Date so we know it parses cleanly.
    const parsed = new Date(env.generated_at);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // ISO 8601 UTC timestamps produced by Date.prototype.toISOString end in Z.
    expect(env.generated_at.endsWith('Z')).toBe(true);
  });

  test('data field carries the payload (with _disclosure spread in)', () => {
    const env = buildEnvelope({ pack: 'boxset-1', count: 3 });
    const data = env.data as { pack: string; count: number; _disclosure: string };
    expect(data.pack).toBe('boxset-1');
    expect(data.count).toBe(3);
    // The legacy client contract keys off `_disclosure` embedded inside
    // `data`. Spread injection preserves that contract without a separate
    // attachDisclosure call.
    expect(typeof data._disclosure).toBe('string');
    expect(data._disclosure.length).toBeGreaterThan(0);
    expect(data._disclosure).toContain('Not financial advice');
  });

  test('non-object data is NOT wrapped with _disclosure', () => {
    // Arrays would become weird (`arr._disclosure` is not compatible with
    // for-of / .map consumers), and primitives can't be extended.
    const arrEnv = buildEnvelope([1, 2, 3]);
    expect(Array.isArray(arrEnv.data)).toBe(true);
    expect((arrEnv.data as unknown as { _disclosure?: string })._disclosure).toBeUndefined();

    const strEnv = buildEnvelope('hello');
    expect(strEnv.data).toBe('hello');

    const nullEnv = buildEnvelope(null);
    expect(nullEnv.data).toBeNull();
  });

  test('attachDisclosure: false suppresses the marker', () => {
    const env = buildEnvelope({ pack: 'x' }, { attachDisclosure: false });
    const data = env.data as { pack: string; _disclosure?: string };
    expect(data.pack).toBe('x');
    expect(data._disclosure).toBeUndefined();
  });
});

describe('buildEnvelope — BETA warning', () => {
  test('BETA_WARNING has the exact file 17 §7 copy', () => {
    expect(BETA_WARNING.code).toBe('BETA');
    expect(BETA_WARNING.message).toBe(
      'Beta data from Renaiss API and Renaiss Index API (experimental). Sources cited. Not financial advice.'
    );
  });

  test('warnings always includes BETA by default', () => {
    const env = buildEnvelope({ x: 1 });
    expect(env.warnings.length).toBeGreaterThanOrEqual(1);
    const betaFound = env.warnings.some((w) => w.code === 'BETA');
    expect(betaFound).toBe(true);
  });

  test('BETA is prepended even when caller supplies extra warnings', () => {
    const env = buildEnvelope(
      { x: 1 },
      {
        warnings: [
          { code: 'UPSTREAM_UNAVAILABLE', message: 'x is down' },
          { code: 'INSUFFICIENT_SAMPLE', message: 'n<10' },
        ],
      }
    );
    expect(env.warnings[0].code).toBe('BETA');
    expect(env.warnings.length).toBe(3);
    expect(env.warnings.map((w) => w.code)).toEqual([
      'BETA',
      'UPSTREAM_UNAVAILABLE',
      'INSUFFICIENT_SAMPLE',
    ]);
  });

  test('duplicate BETA in caller warnings is deduplicated', () => {
    const env = buildEnvelope(
      { x: 1 },
      {
        warnings: [
          { code: 'BETA', message: 'custom beta' },
          { code: 'OTHER', message: 'other' },
        ],
      }
    );
    const betaCount = env.warnings.filter((w) => w.code === 'BETA').length;
    expect(betaCount).toBe(1);
    // The canonical BETA is the one that stays (leading position).
    expect(env.warnings[0].message).toBe(BETA_WARNING.message);
  });

  test('includeBeta: false suppresses BETA entirely (internal routes)', () => {
    const env = buildEnvelope(
      { x: 1 },
      {
        includeBeta: false,
        warnings: [{ code: 'INTERNAL', message: 'debug' }],
      }
    );
    const betaFound = env.warnings.some((w) => w.code === 'BETA');
    expect(betaFound).toBe(false);
    expect(env.warnings.length).toBe(1);
  });
});

describe('buildEnvelope — sources', () => {
  test('empty sources by default (route must opt-in)', () => {
    const env = buildEnvelope({ x: 1 });
    expect(env.sources).toEqual([]);
  });

  test('sources array is typed as {label, url}', () => {
    const env = buildEnvelope(
      { x: 1 },
      {
        sources: [
          { label: 'A', url: 'https://a.example' },
          { label: 'B', url: 'https://b.example' },
        ],
      }
    );
    expect(env.sources.length).toBe(2);
    for (const s of env.sources) {
      expect(typeof s.label).toBe('string');
      expect(typeof s.url).toBe('string');
      expect(s.url.startsWith('https://')).toBe(true);
    }
  });
});

describe('standard source constants', () => {
  test('SOURCE_RENAISS_MAIN has label + url', () => {
    expect(typeof SOURCE_RENAISS_MAIN.label).toBe('string');
    expect(SOURCE_RENAISS_MAIN.url).toBe('https://api.renaiss.xyz');
  });

  test('SOURCE_RENAISS_INDEX has label + url', () => {
    expect(typeof SOURCE_RENAISS_INDEX.label).toBe('string');
    expect(SOURCE_RENAISS_INDEX.url).toBe('https://api.renaissos.com/v1');
  });

  test('SOURCE_BSC_ORDERBOOK cites bscscan', () => {
    expect(SOURCE_BSC_ORDERBOOK.url).toContain('bscscan.com');
  });

  test('SOURCE_BSC_TVM cites bscscan', () => {
    expect(SOURCE_BSC_TVM.url).toContain('bscscan.com');
  });
});

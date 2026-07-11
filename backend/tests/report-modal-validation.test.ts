/**
 * D8-M-4 regression: the `report-btn:` and `report-modal:` customId parsers
 * MUST re-apply the same `CERT_RX` / `TOKEN_RX` allowlists that the emit side
 * enforces, so an attacker who crafts a fake button in another server cannot
 * redirect malformed values (e.g. shell metacharacters, SQL fragments, URL-
 * looking strings) into the Renaiss report API.
 *
 * These tests exercise the exported `parseModalCustomId` and
 * `parseButtonCustomId` helpers directly. No Discord client, no rate-limiter,
 * no upstream fetch.
 */

import { describe, test, expect } from 'bun:test';

import {
  parseButtonCustomId,
  parseModalCustomId,
  REPORT_BUTTON_PREFIX,
  REPORT_MODAL_PREFIX,
} from '../src/lib/discord/commands/report-customid.ts';

describe('parseModalCustomId (D8-M-4)', () => {
  test('accepts a well-formed cert customId', () => {
    const parsed = parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:PSA73628064`);
    expect(parsed).toEqual({ kind: 'cert', value: 'PSA73628064' });
  });

  test('accepts BGS / CGC / SGC cert prefixes', () => {
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:BGS12345678`)).toEqual({
      kind: 'cert',
      value: 'BGS12345678',
    });
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:CGC98765432`)).toEqual({
      kind: 'cert',
      value: 'CGC98765432',
    });
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:SGC1234567`)).toEqual({
      kind: 'cert',
      value: 'SGC1234567',
    });
  });

  test('accepts numeric token customId', () => {
    const parsed = parseModalCustomId(`${REPORT_MODAL_PREFIX}token:123456789`);
    expect(parsed).toEqual({ kind: 'token', value: '123456789' });
  });

  test('rejects malformed cert (non-grader prefix)', () => {
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:ABC12345678`)).toBeNull();
  });

  test('rejects malformed cert (too few digits)', () => {
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:PSA123`)).toBeNull();
  });

  test('rejects malformed cert (too many digits)', () => {
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:PSA1234567890123`)).toBeNull();
  });

  test('rejects malformed cert (embedded shell metacharacters)', () => {
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:PSA123456;rm -rf /`)).toBeNull();
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:PSA'OR 1=1--`)).toBeNull();
  });

  test('rejects cert with URL-like content (SSRF poison)', () => {
    expect(
      parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:https://attacker.com`)
    ).toBeNull();
    expect(
      parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:PSA://169.254.169.254`)
    ).toBeNull();
  });

  test('rejects malformed token (non-digit)', () => {
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}token:abc123`)).toBeNull();
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}token:-1`)).toBeNull();
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}token:1.5`)).toBeNull();
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}token: 1`)).toBeNull();
  });

  test('rejects unknown kind', () => {
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}wallet:0xdead`)).toBeNull();
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}:PSA73628064`)).toBeNull();
  });

  test('rejects empty value', () => {
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:`)).toBeNull();
  });

  test('rejects value that is too long (>200 chars)', () => {
    const longValue = 'PSA' + '1'.repeat(300);
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:${longValue}`)).toBeNull();
  });

  test('rejects customId that does not start with the modal prefix', () => {
    expect(parseModalCustomId('random-modal:cert:PSA73628064')).toBeNull();
    // Even the sibling button prefix must be rejected here.
    expect(parseModalCustomId(`${REPORT_BUTTON_PREFIX}cert:PSA73628064`)).toBeNull();
  });

  test('rejects missing separator', () => {
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}cert`)).toBeNull();
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}certPSA73628064`)).toBeNull();
  });

  test('rejects nested colon injection', () => {
    // First colon is the kind separator, but the value must still match the
    // regex. `cert:PSA:73628064` would parse value=`PSA:73628064` which fails
    // CERT_RX.
    expect(parseModalCustomId(`${REPORT_MODAL_PREFIX}cert:PSA:73628064`)).toBeNull();
  });
});

describe('parseButtonCustomId (D8-M-4)', () => {
  test('accepts a well-formed cert customId', () => {
    const parsed = parseButtonCustomId(`${REPORT_BUTTON_PREFIX}cert:PSA73628064`);
    expect(parsed).toEqual({ kind: 'cert', value: 'PSA73628064' });
  });

  test('accepts numeric token customId', () => {
    const parsed = parseButtonCustomId(`${REPORT_BUTTON_PREFIX}token:987654321`);
    expect(parsed).toEqual({ kind: 'token', value: '987654321' });
  });

  test('rejects malformed cert (non-grader prefix)', () => {
    expect(parseButtonCustomId(`${REPORT_BUTTON_PREFIX}cert:XYZ12345678`)).toBeNull();
  });

  test('rejects malformed token (non-digit)', () => {
    expect(parseButtonCustomId(`${REPORT_BUTTON_PREFIX}token:0xdeadbeef`)).toBeNull();
    expect(parseButtonCustomId(`${REPORT_BUTTON_PREFIX}token:1e10`)).toBeNull();
  });

  test('rejects a customId that would only pass the pre-M-4 length + prefix check', () => {
    // Value under 200 chars, starts with the prefix, has a valid kind, but
    // value fails the regex. Pre-M-4 the parser accepted this. Now it does
    // not.
    expect(parseButtonCustomId(`${REPORT_BUTTON_PREFIX}cert:notacert`)).toBeNull();
    expect(parseButtonCustomId(`${REPORT_BUTTON_PREFIX}token:not-a-number`)).toBeNull();
  });

  test('rejects customId that does not start with the button prefix', () => {
    expect(parseButtonCustomId('report-cta:cert:PSA73628064')).toBeNull();
    expect(parseButtonCustomId(`${REPORT_MODAL_PREFIX}cert:PSA73628064`)).toBeNull();
  });

  test('rejects zero-width unicode padding around the value', () => {
    // Zero-width space between digits should fail CERT_RX (non-word chars).
    expect(parseButtonCustomId(`${REPORT_BUTTON_PREFIX}cert:PSA7​3628064`)).toBeNull();
  });
});

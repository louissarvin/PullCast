/**
 * Tests for the `renaissUserSchema` runtime validator + `renaissApi.getUser`
 * UUID guard.
 *
 * Fixtures live in `tests/fixtures/renaiss/`:
 *   - user-openapi-derived-success.json: success shape strictly derived from
 *     the live openapi.json contract for GET /v0/users/{id}. No mock: every
 *     field name / type / required-set matches what the API says it returns.
 *     A live captured example is not included because the public Renaiss main
 *     API surface has no anonymous user-discovery path (see
 *     memory/d8-user-odds-progress.md).
 *   - user-404.json: LIVE captured error body for a nil-UUID GET.
 *   - user-400.json: LIVE captured error body for a malformed-UUID GET.
 *   - user-openapi-contract.json: LIVE captured openapi excerpt (schema of
 *     record for the endpoint).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renaissUserSchema } from '../src/lib/renaiss/schemas.ts';
import { renaissApi, RenaissApiError } from '../src/lib/renaiss/index.ts';

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures', 'renaiss');

const readFixture = (name: string): unknown => {
  const path = resolve(FIXTURE_DIR, name);
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
};

describe('renaissUserSchema', () => {
  test('accepts a full success payload matching the openapi contract', () => {
    const fx = readFixture('user-openapi-derived-success.json');
    const parsed = renaissUserSchema.safeParse(fx);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
      expect(parsed.data.username).toBe('ExampleCollector');
      expect(parsed.data.avatarUrl).toBe(
        'https://cdn.renaiss.xyz/avatars/aaaaaaaa.png'
      );
      expect(parsed.data.favoritedCollectibles).toHaveLength(2);
      expect(parsed.data.favoritedSBTs).toHaveLength(1);
    }
  });

  test('accepts favoritedCollectibles[].collectible === null', () => {
    const fx = readFixture(
      'user-openapi-derived-success.json'
    ) as Record<string, unknown>;
    const withOnlyNullCollectible = {
      ...fx,
      favoritedCollectibles: [
        { tokenId: '12345', collectible: null },
      ],
    };
    const parsed = renaissUserSchema.safeParse(withOnlyNullCollectible);
    expect(parsed.success).toBe(true);
  });

  test('rejects when id is not a UUID', () => {
    const fx = readFixture(
      'user-openapi-derived-success.json'
    ) as Record<string, unknown>;
    const bad = { ...fx, id: 'not-a-uuid' };
    const parsed = renaissUserSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  test('rejects when required avatarUrl is missing', () => {
    const fx = readFixture(
      'user-openapi-derived-success.json'
    ) as Record<string, unknown>;
    const bad = { ...fx };
    delete (bad as { avatarUrl?: unknown }).avatarUrl;
    const parsed = renaissUserSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  test('rejects legacy shape with `avatar` instead of `avatarUrl`', () => {
    // The prior sketch in file 15 used `avatar`; the LIVE contract uses
    // `avatarUrl`. Guard against future drift.
    const parsed = renaissUserSchema.safeParse({
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      username: 'x',
      avatar: 'https://x/a.png',
      favoritedCollectibles: [],
      favoritedSBTs: [],
    });
    expect(parsed.success).toBe(false);
  });

  test('rejects legacy shape with `sbtBadges` instead of `favoritedSBTs`', () => {
    const parsed = renaissUserSchema.safeParse({
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      username: 'x',
      avatarUrl: 'https://x/a.png',
      favoritedCollectibles: [],
      sbtBadges: [],
    });
    expect(parsed.success).toBe(false);
  });

  test('passthrough survives unknown top-level keys', () => {
    const fx = readFixture(
      'user-openapi-derived-success.json'
    ) as Record<string, unknown>;
    const withExtra = { ...fx, futureFieldX: 'ignored-but-preserved' };
    const parsed = renaissUserSchema.safeParse(withExtra);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Zod .passthrough() keeps extras on the parsed object.
      expect((parsed.data as Record<string, unknown>).futureFieldX).toBe(
        'ignored-but-preserved'
      );
    }
  });

  test('live 404 body has the { error, code } shape we branch on', () => {
    const fx = readFixture('user-404.json') as Record<string, unknown>;
    expect(fx.code).toBe('USER_NOT_FOUND');
    expect(typeof fx.error).toBe('string');
  });

  test('live 400 body has the ZodError-shaped payload we branch on', () => {
    const fx = readFixture('user-400.json') as Record<string, unknown>;
    expect(fx.success).toBe(false);
    // Upstream returns a `.error` object whose `.issues` array names the
    // failing field. We only surface a friendly 400 to our own clients, but
    // the shape is documented here so a future upstream tweak surfaces in CI.
    expect(fx.error).toBeTruthy();
  });
});

describe('renaissApi.getUser (UUID guard)', () => {
  test('throws RenaissApiError with status=null on wallet-shaped input', async () => {
    let threw = false;
    try {
      await renaissApi.getUser('0x' + 'a'.repeat(40));
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(RenaissApiError);
      if (err instanceof RenaissApiError) {
        expect(err.status).toBeNull();
        expect(err.endpoint).toBe('/users/{id}');
      }
    }
    expect(threw).toBe(true);
  });

  test('throws RenaissApiError on empty string', async () => {
    let threw = false;
    try {
      await renaissApi.getUser('');
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(RenaissApiError);
    }
    expect(threw).toBe(true);
  });

  test('throws RenaissApiError on obvious garbage', async () => {
    let threw = false;
    try {
      await renaissApi.getUser('DROP TABLE users;--');
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(RenaissApiError);
    }
    expect(threw).toBe(true);
  });
});

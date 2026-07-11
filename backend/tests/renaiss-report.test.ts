/**
 * Tests for the M8 report surface:
 *
 *  1. `reportIssueInputSchema` — the STRICT wire-format zod schema. Verifies
 *     required fields, enum bounds, empty-string vs missing semantics, and
 *     rejects unknown keys (the upstream contract is
 *     `additionalProperties: false`).
 *
 *  2. `renaissIndex.reportIssue` — the semantic client method. Uses a fetch
 *     mock to verify the payload the wire receives (mapping from the
 *     PullCast-semantic input to the OpenAPI wire shape) and the return
 *     value shape.
 */

// Stub the required env vars BEFORE any module that imports main-config
// loads (client.ts pulls RENAISS_INDEX_BASE from there, and the config
// module `process.exit(1)`s at import if any required env is missing).
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? 'test-token';
process.env.DISCORD_APP_ID = process.env.DISCORD_APP_ID ?? 'test-app';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY ?? 'test-key-groq-must-exceed-twenty-chars';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  REPORT_CATEGORY_VALUES,
  reportIssueInputSchema,
  reportSubmitResponseSchema,
} from '../src/lib/renaiss-index/schemas.ts';
import { renaissIndex } from '../src/lib/renaiss-index/client.ts';
import { IndexApiError } from '../src/lib/renaiss-index/errors.ts';

// -------------------------------------------------------------------------
// Schema tests
// -------------------------------------------------------------------------

describe('reportIssueInputSchema', () => {
  test('accepts the minimal required shape', () => {
    const result = reportIssueInputSchema.safeParse({ message: 'x' });
    expect(result.success).toBe(true);
  });

  test('rejects missing message', () => {
    const result = reportIssueInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('rejects empty message', () => {
    const result = reportIssueInputSchema.safeParse({ message: '' });
    expect(result.success).toBe(false);
  });

  test('rejects message longer than 2000 chars', () => {
    const result = reportIssueInputSchema.safeParse({ message: 'a'.repeat(2001) });
    expect(result.success).toBe(false);
  });

  test('accepts all live enum values for category', () => {
    for (const cat of REPORT_CATEGORY_VALUES) {
      const result = reportIssueInputSchema.safeParse({ message: 'x', category: cat });
      expect(result.success).toBe(true);
    }
  });

  test('rejects unknown category', () => {
    const result = reportIssueInputSchema.safeParse({ message: 'x', category: 'not-a-cat' });
    expect(result.success).toBe(false);
  });

  test('accepts sourceUrl as empty string OR valid URL', () => {
    expect(reportIssueInputSchema.safeParse({ message: 'x', sourceUrl: '' }).success).toBe(true);
    expect(
      reportIssueInputSchema.safeParse({ message: 'x', sourceUrl: 'https://renaiss.xyz/x' }).success
    ).toBe(true);
    // A bare non-URL string is rejected.
    expect(reportIssueInputSchema.safeParse({ message: 'x', sourceUrl: 'not a url' }).success).toBe(
      false
    );
  });

  test('accepts contactEmail as empty string OR valid email', () => {
    expect(reportIssueInputSchema.safeParse({ message: 'x', contactEmail: '' }).success).toBe(true);
    expect(
      reportIssueInputSchema.safeParse({ message: 'x', contactEmail: 'a@b.co' }).success
    ).toBe(true);
    expect(
      reportIssueInputSchema.safeParse({ message: 'x', contactEmail: 'not-an-email' }).success
    ).toBe(false);
  });

  test('rejects unknown top-level keys (mirrors upstream additionalProperties:false)', () => {
    const result = reportIssueInputSchema.safeParse({ message: 'x', extra: 'nope' });
    expect(result.success).toBe(false);
  });
});

describe('reportSubmitResponseSchema', () => {
  test('accepts a 201 body from the live contract', () => {
    const result = reportSubmitResponseSchema.safeParse({
      ok: true,
      id: '12345678-1234-4234-8234-123456789abc',
    });
    expect(result.success).toBe(true);
  });

  test('rejects ok:false', () => {
    const result = reportSubmitResponseSchema.safeParse({
      ok: false,
      id: '12345678-1234-4234-8234-123456789abc',
    });
    expect(result.success).toBe(false);
  });

  test('rejects a non-uuid id', () => {
    const result = reportSubmitResponseSchema.safeParse({ ok: true, id: 'abc' });
    expect(result.success).toBe(false);
  });
});

// -------------------------------------------------------------------------
// renaissIndex.reportIssue happy-path integration test (fetch mocked).
// -------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

describe('renaissIndex.reportIssue', () => {
  const realFetch = globalThis.fetch;
  let captured: CapturedRequest | null = null;

  beforeEach(() => {
    captured = null;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('posts a mapped wire payload and returns { received:true, reportId }', async () => {
    // Mock fetch: capture the request, respond with the live 201 shape.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: typeof input === 'string' ? input : input.toString(),
        method: init?.method ?? 'GET',
        body:
          typeof init?.body === 'string' ? (JSON.parse(init.body as string) as unknown) : null,
      };
      return new Response(
        JSON.stringify({ ok: true, id: '11111111-2222-4333-8444-555555555555' }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const result = await renaissIndex.reportIssue({
      card: { cert: 'PSA73628064' },
      reason: 'FMV looks wildly stale',
      evidence: 'https://renaiss.xyz/card/PSA73628064',
      submitterHandle: 'discord:user-42',
    });

    expect(result.received).toBe(true);
    expect(result.reportId).toBe('11111111-2222-4333-8444-555555555555');

    // Wire payload assertions.
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe('POST');
    expect(captured!.url).toMatch(/\/v1\/report$/);
    const body = captured!.body as {
      message: string;
      sourceUrl?: string;
      extra?: unknown;
    };
    // Message must contain the cert prefix (so upstream reviewers can find it).
    expect(body.message).toContain('cert:PSA73628064');
    // The Discord handle is embedded in the message prefix so the reviewer can
    // reach the reporter (upstream schema has no free-form contact field).
    expect(body.message).toContain('submitterHandle:discord:user-42');
    expect(body.message).toContain('FMV looks wildly stale');
    // sourceUrl is populated because evidence was a valid https URL.
    expect(body.sourceUrl).toBe('https://renaiss.xyz/card/PSA73628064');
    // Wire is `.strict()` - the semantic keys (submitterHandle etc) must not
    // leak onto the wire.
    expect((body as Record<string, unknown>).submitterHandle).toBeUndefined();
    expect((body as Record<string, unknown>).evidence).toBeUndefined();
    expect((body as Record<string, unknown>).card).toBeUndefined();
  });

  test('folds non-URL evidence into the message tail', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: typeof input === 'string' ? input : input.toString(),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      };
      return new Response(
        JSON.stringify({ ok: true, id: '11111111-2222-4333-8444-666666666666' }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    await renaissIndex.reportIssue({
      card: { tokenId: '999' },
      reason: 'wrong tier displayed',
      evidence: 'saw it on twitter, no link handy',
    });

    const body = captured!.body as { message: string; sourceUrl?: string };
    expect(body.sourceUrl).toBeUndefined();
    expect(body.message).toContain('Evidence: saw it on twitter, no link handy');
    expect(body.message).toContain('tokenId:999');
  });

  test('rejects empty reason at the boundary (no network call)', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await expect(
      renaissIndex.reportIssue({ reason: '   ' })
    ).rejects.toBeInstanceOf(IndexApiError);
    expect(called).toBe(false);
  });

  test('maps upstream 422 into an IndexApiError with status 422', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: 'bad' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await renaissIndex.reportIssue({ reason: 'x' });
      throw new Error('expected reportIssue to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IndexApiError);
      expect((err as IndexApiError).status).toBe(422);
    }
  });
});

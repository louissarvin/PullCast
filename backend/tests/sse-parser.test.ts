/**
 * Tests for the Renaiss Index SSE parser (src/lib/renaiss-index/sse.ts).
 *
 * The parser is the load-bearing piece for both `/api/valuate/photo` and
 * `/valuate cert`. If it drops a `progress` frame, corrupts the terminal
 * `result` payload, or fails to fire the disclosure augmentation, users see
 * broken UX. These tests exercise:
 *   1. Ordered progress callbacks over a mock event stream.
 *   2. Terminal result payload matches `indexGradedSchema` and carries the
 *      `_disclosure` marker (safety mandate).
 *   3. `failed` events surface as an IndexApiError.
 *   4. Multi-line `data:` fields are joined per spec.
 *   5. Stage-timeout fires when the stream stalls.
 */

import { describe, test, expect } from 'bun:test';

import { consumeGradedSseStream, __test } from '../src/lib/renaiss-index/sse.ts';
import { indexGradedSchema } from '../src/lib/renaiss-index/schemas.ts';
import { INDEX_BETA_DISCLOSURE } from '../src/lib/renaiss-index/types-runtime.ts';
import { IndexApiError } from '../src/lib/renaiss-index/errors.ts';

/**
 * Build a ReadableStream<Uint8Array> that yields the given SSE chunks in
 * order. Chunk boundaries are preserved so we can exercise partial-frame
 * buffering.
 */
const makeStreamFromChunks = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
};

/**
 * Build a stalled stream: emits the initial chunks then withholds further
 * output for the given delay. Used to force a stage-timeout without hanging
 * the test runner indefinitely if the timer misfires.
 */
const makeStalledStream = (
  chunks: string[],
  stallForMs: number = 2000
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < chunks.length) {
        controller.enqueue(encoder.encode(chunks[sent++]));
        return;
      }
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          controller.close();
          resolve();
        }, stallForMs);
      });
    },
  });
};

const validGradedPayload = {
  cert: 'PSA149595098',
  certNumber: '149595098',
  company: 'PSA',
  found: true,
  grade: 10,
  gradeLabel: 'GEM MT 10',
  card: {
    name: 'Charizard',
    setName: 'Base Set',
    cardNumber: '4',
    grade: '10',
    priceUsdCents: 350000,
    confidence: 'high' as const,
    lastSaleAt: '2026-06-01T12:00:00Z',
    imageUrl: 'https://cdn.renaiss.xyz/cards/charizard.jpg',
  },
  certImages: {
    front: 'https://cdn.renaiss.xyz/certs/149595098-front.jpg',
    back: 'https://cdn.renaiss.xyz/certs/149595098-back.jpg',
  },
};

describe('sse.iterateSseEvents (low-level)', () => {
  test('parses a single event with a data payload', async () => {
    const stream = makeStreamFromChunks([
      'event: progress\r\n',
      'data: {"stage":"identify","message":"reading card"}\r\n\r\n',
    ]);
    const events: Array<{ event: string; data: string }> = [];
    for await (const evt of __test.iterateSseEvents(stream)) {
      events.push(evt);
    }
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('progress');
    expect(JSON.parse(events[0].data)).toEqual({
      stage: 'identify',
      message: 'reading card',
    });
  });

  test('joins multi-line data payloads with newlines per the SSE spec', async () => {
    const stream = makeStreamFromChunks([
      'event: progress\ndata: line1\ndata: line2\n\n',
    ]);
    const events: Array<{ event: string; data: string }> = [];
    for await (const evt of __test.iterateSseEvents(stream)) {
      events.push(evt);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('line1\nline2');
  });

  test('handles a frame split across chunks', async () => {
    const stream = makeStreamFromChunks([
      'event: prog',
      'ress\n',
      'data: {"stage":"identify",',
      '"message":"x"}\n\n',
    ]);
    const events: Array<{ event: string; data: string }> = [];
    for await (const evt of __test.iterateSseEvents(stream)) {
      events.push(evt);
    }
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('progress');
    expect(JSON.parse(events[0].data)).toEqual({
      stage: 'identify',
      message: 'x',
    });
  });

  test('ignores SSE comment lines (leading colon)', async () => {
    const stream = makeStreamFromChunks([
      ': keep-alive ping\n',
      'event: progress\n',
      'data: {"stage":"enrich","message":"x"}\n\n',
    ]);
    const events: Array<{ event: string; data: string }> = [];
    for await (const evt of __test.iterateSseEvents(stream)) {
      events.push(evt);
    }
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('progress');
  });
});

describe('consumeGradedSseStream (high-level pipeline)', () => {
  test('fires onProgress in order, resolves to a schema-valid result with disclosure', async () => {
    const stream = makeStreamFromChunks([
      'event: progress\ndata: {"stage":"cert_lookup","message":"looking up"}\n\n',
      'event: progress\ndata: {"stage":"identify","message":"reading card"}\n\n',
      'event: progress\ndata: {"stage":"enrich","message":"gathering metadata"}\n\n',
      'event: progress\ndata: {"stage":"fmv","message":"computing FMV"}\n\n',
      `event: result\ndata: ${JSON.stringify(validGradedPayload)}\n\n`,
    ]);

    const progressCalls: string[] = [];
    const result = await consumeGradedSseStream(stream, {
      endpoint: '/graded/{cert}/stream',
      onProgress: (p) => {
        progressCalls.push(p.stage);
      },
      overallTimeoutMs: 5000,
      stageTimeoutMs: 2000,
    });

    expect(progressCalls).toEqual(['cert_lookup', 'identify', 'enrich', 'fmv']);
    expect(result.cert).toBe('PSA149595098');
    expect(result.found).toBe(true);
    // Disclosure is the safety mandate. Every returned object MUST carry it.
    expect(result._disclosure).toBe(INDEX_BETA_DISCLOSURE);
    // Payload must round-trip through the runtime schema.
    const validated = indexGradedSchema.safeParse(result);
    expect(validated.success).toBe(true);
  });

  test('surfaces `failed` events as IndexApiError with the upstream detail', async () => {
    const stream = makeStreamFromChunks([
      'event: progress\ndata: {"stage":"identify","message":"reading"}\n\n',
      'event: failed\ndata: {"error":"image_unreadable","detail":"blurry photo"}\n\n',
    ]);

    let threw: unknown = null;
    try {
      await consumeGradedSseStream(stream, {
        endpoint: '/graded/by-image',
        overallTimeoutMs: 5000,
        stageTimeoutMs: 2000,
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(IndexApiError);
    expect((threw as IndexApiError).message).toContain('image_unreadable');
    expect((threw as IndexApiError).cause).toBe('blurry photo');
  });

  test('accepts `done` as an alias for `result` (defensive against upstream naming drift)', async () => {
    // The live spec uses `result`; the task brief mentioned `done`. Support
    // both so a rename cannot silently break us.
    const stream = makeStreamFromChunks([
      `event: done\ndata: ${JSON.stringify(validGradedPayload)}\n\n`,
    ]);
    const result = await consumeGradedSseStream(stream, {
      endpoint: '/graded/{cert}/stream',
      overallTimeoutMs: 5000,
      stageTimeoutMs: 2000,
    });
    expect(result.found).toBe(true);
    expect(result._disclosure).toBe(INDEX_BETA_DISCLOSURE);
  });

  test('throws when the stream ends without a result event', async () => {
    const stream = makeStreamFromChunks([
      'event: progress\ndata: {"stage":"identify","message":"x"}\n\n',
    ]);
    let threw: unknown = null;
    try {
      await consumeGradedSseStream(stream, {
        endpoint: '/graded/by-image',
        overallTimeoutMs: 5000,
        stageTimeoutMs: 2000,
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(IndexApiError);
    expect((threw as IndexApiError).message).toContain('ended without a result');
  });

  test('stage-timeout fires when the upstream stalls between frames', async () => {
    const stream = makeStalledStream([
      'event: progress\ndata: {"stage":"identify","message":"x"}\n\n',
    ]);
    let threw: unknown = null;
    try {
      await consumeGradedSseStream(stream, {
        endpoint: '/graded/by-image',
        overallTimeoutMs: 5000,
        stageTimeoutMs: 200, // 200ms is enough to prove the timer works
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(IndexApiError);
    expect((threw as IndexApiError).message).toMatch(/timeout/);
  });

  test('malformed progress JSON is skipped (do not tear down the stream)', async () => {
    const stream = makeStreamFromChunks([
      'event: progress\ndata: {not-json}\n\n',
      'event: progress\ndata: {"stage":"enrich","message":"x"}\n\n',
      `event: result\ndata: ${JSON.stringify(validGradedPayload)}\n\n`,
    ]);
    const progressCalls: string[] = [];
    const result = await consumeGradedSseStream(stream, {
      endpoint: '/graded/by-image',
      onProgress: (p) => {
        progressCalls.push(p.stage);
      },
      overallTimeoutMs: 5000,
      stageTimeoutMs: 2000,
    });
    // Only the well-formed progress frame should fire the callback.
    expect(progressCalls).toEqual(['enrich']);
    expect(result.found).toBe(true);
  });
});

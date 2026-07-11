/**
 * D8 MAJOR #5: `valuateByImage` must enforce a local timeout on the initial
 * POST /v1/graded/by-image fetch. Without this, a hung TCP connection to
 * Renaiss can pin a Fastify worker indefinitely when the caller does not pass
 * an AbortSignal.
 *
 * Approach:
 *   - Stub `globalThis.fetch` with a promise that never resolves except when
 *     its signal fires.
 *   - Call `valuateByImage` with NO caller-supplied signal.
 *   - Assert it rejects with an IndexApiError referencing the local timeout.
 *
 * We avoid `bun:test`'s fake-timer API because native `fetch` under Bun uses
 * a real event loop reactor; a mocked timer would not fire our AbortController.
 * Instead we accelerate the test by monkey-patching PHOTO_REQUEST_TIMEOUT_MS
 * via a delegating fetch that races against a short setTimeout.
 */

import { describe, test, expect, afterEach } from 'bun:test';

import { valuateByImage } from '../src/lib/renaiss-index/photo.ts';
import { IndexApiError } from '../src/lib/renaiss-index/errors.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x01]);

describe('valuateByImage — initial fetch timeout (MAJOR #5)', () => {
  test('local AbortController fires when upstream hangs (no caller signal)', async () => {
    // Stub fetch that only resolves when its signal aborts. This is what a
    // hung TCP connection looks like from the AbortController's POV.
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          // If the code under test forgot to pass a signal, the test still
          // fails: no signal means no reject path so the promise hangs and
          // the outer bun:test timeout catches it.
          return;
        }
        if (signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true }
        );
      });
    }) as typeof globalThis.fetch;

    // No caller signal → only the local 8s timer can rescue us.
    // We accept the 8s wall-clock cost in exchange for a real test.
    // Bun's default test timeout is 5s; extend it explicitly.
    const start = Date.now();
    let caught: unknown = null;
    try {
      await valuateByImage(jpegBuffer, 'test.jpg', 'image/jpeg');
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(IndexApiError);
    if (caught instanceof IndexApiError) {
      // The message identifies this as an initial-fetch timeout, not a
      // generic network error, so operators can distinguish upstream-hung
      // from upstream-4xx during triage.
      expect(caught.message.toLowerCase()).toContain('exceeded');
      expect(caught.status).toBeNull();
      expect(caught.endpoint).toBe('/graded/by-image');
    }
    // Should have taken about the 8s local timeout, not the 60s overall.
    // Allow generous slack so CI variance does not flake the test.
    expect(elapsed).toBeGreaterThanOrEqual(7_500);
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  test('caller-supplied signal preempts the local timer', async () => {
    // When the caller passes their own AbortController and aborts it BEFORE
    // the 8s local timer fires, we must reject with the caller-abort message
    // so operators can distinguish client-hangup from upstream-hung.
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true }
        );
      });
    }) as typeof globalThis.fetch;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const start = Date.now();
    let caught: unknown = null;
    try {
      await valuateByImage(jpegBuffer, 'test.jpg', 'image/jpeg', {
        signal: controller.signal,
      });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(IndexApiError);
    if (caught instanceof IndexApiError) {
      // Caller-abort path yields a specific message so triage can
      // distinguish client hangup from upstream hang.
      expect(caught.message.toLowerCase()).toContain('aborted by caller');
    }
    // Aborted well before the 8s local ceiling.
    expect(elapsed).toBeLessThan(2_000);
  });

  test('pre-aborted signal rejects immediately', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as typeof globalThis.fetch;

    const controller = new AbortController();
    controller.abort();

    let caught: unknown = null;
    try {
      await valuateByImage(jpegBuffer, 'test.jpg', 'image/jpeg', {
        signal: controller.signal,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IndexApiError);
  });
});

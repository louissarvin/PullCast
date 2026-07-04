/**
 * Minimal SSE (Server-Sent Events) parser tuned for the Renaiss Index streaming
 * endpoints. The spec is small enough that a hand-rolled parser is cheaper
 * than pulling in `eventsource-parser` and easier to unit-test.
 *
 * Frames used by upstream (per the live OpenAPI at api.renaissos.com/v1):
 *   event: progress\n
 *   data: {"stage":"identify","message":"..."}\n
 *   \n
 *
 *   event: result\n
 *   data: {...GradedLookup...}\n
 *   \n
 *
 *   event: failed\n
 *   data: {"error":"image_unreadable","detail":"..."}\n
 *   \n
 *
 * NOTE: the task brief mentioned `done` but the live spec ships `result`. This
 * parser accepts both (result is authoritative) so a future rename does not
 * break us silently.
 */

import { z } from 'zod';
import { indexGradedSchema } from './schemas.ts';
import { IndexApiError } from './errors.ts';
import { INDEX_BETA_DISCLOSURE } from './types-runtime.ts';
import type { IndexGraded } from './types.ts';

/**
 * Pipeline stage names emitted by the upstream progress frames.
 */
export type PipelineStage =
  | 'cert_lookup'
  | 'identify'
  | 'enrich'
  | 'find_item'
  | 'cache_check'
  | 'match'
  | 'crawl'
  | 'fmv'
  | 'done';

export interface PipelineProgress {
  stage: PipelineStage;
  message: string;
  status?: 'running' | 'ok' | 'skipped' | 'error';
  done?: boolean;
  data?: unknown;
}

const pipelineProgressSchema = z
  .object({
    stage: z.enum([
      'cert_lookup',
      'identify',
      'enrich',
      'find_item',
      'cache_check',
      'match',
      'crawl',
      'fmv',
      'done',
    ]),
    message: z.string(),
    status: z.enum(['running', 'ok', 'skipped', 'error']).optional(),
    done: z.boolean().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const failedSchema = z
  .object({
    error: z.string().optional(),
    detail: z.string().optional(),
  })
  .passthrough();

export type ProgressCallback = (progress: PipelineProgress) => void;

interface SseEvent {
  event: string;
  data: string;
}

/**
 * Iterate SSE events from a ReadableStream<Uint8Array>. Yields once per
 * completed event (i.e. once per blank-line-terminated frame). Handles
 * multi-line `data:` fields per the SSE spec by joining with `\n`.
 */
async function* iterateSseEvents(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const emitFromBuffer = (): SseEvent | null => {
    // Look for a blank-line frame terminator. Support LF, CRLF, and mixed.
    const sepIndex = buffer.search(/\r?\n\r?\n/);
    if (sepIndex === -1) return null;

    const rawFrame = buffer.slice(0, sepIndex);
    // Advance past the terminator (2 or 4 chars depending on line endings).
    const terminatorMatch = buffer.slice(sepIndex).match(/^\r?\n\r?\n/);
    const terminatorLen = terminatorMatch ? terminatorMatch[0].length : 2;
    buffer = buffer.slice(sepIndex + terminatorLen);

    let event = 'message';
    const dataLines: string[] = [];
    for (const rawLine of rawFrame.split(/\r?\n/)) {
      if (rawLine.length === 0) continue;
      if (rawLine.startsWith(':')) continue; // SSE comment
      const colon = rawLine.indexOf(':');
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
      // Per spec, a single leading space after the colon is stripped.
      let value = colon === -1 ? '' : rawLine.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
      // Silently ignore `id:` / `retry:` — we do not reconnect.
    }
    return { event, data: dataLines.join('\n') };
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let event = emitFromBuffer();
      while (event !== null) {
        yield event;
        event = emitFromBuffer();
      }
    }
    // Flush any trailing bytes.
    buffer += decoder.decode();
    // Try one last emit if a trailing frame lacks a blank line (defensive; the
    // upstream is spec-compliant so this rarely fires).
    if (buffer.length > 0) {
      const flushed = emitFromBuffer();
      if (flushed !== null) yield flushed;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // best-effort
    }
  }
}

interface ConsumeOptions {
  endpoint: string;
  onProgress?: ProgressCallback;
  /**
   * Ceiling for the entire stream (upstream + all events). Guards against a
   * hung connection burning a Fastify worker.
   */
  overallTimeoutMs?: number;
  /**
   * Max ms allowed between two consecutive frames. Detects a stalled stream
   * where the connection stays open but no progress arrives.
   */
  stageTimeoutMs?: number;
  /**
   * Optional abort signal (e.g. the caller's request was cancelled).
   */
  signal?: AbortSignal;
}

/**
 * Drive an SSE stream to completion. Fires `onProgress` for every `progress`
 * event, resolves with the terminal `result` payload (validated against
 * `indexGradedSchema` and augmented with the beta disclosure), or throws an
 * `IndexApiError` on `failed`, timeout, or malformed data.
 */
export const consumeGradedSseStream = async (
  stream: ReadableStream<Uint8Array>,
  options: ConsumeOptions
): Promise<IndexGraded> => {
  const { endpoint, onProgress } = options;
  const overallTimeoutMs = options.overallTimeoutMs ?? 60_000;
  const stageTimeoutMs = options.stageTimeoutMs ?? 8_000;

  let resolvedResult: IndexGraded | null = null;
  let sawFailed: { error: string; detail: string } | null = null;

  const overallDeadline = Date.now() + overallTimeoutMs;
  let stageDeadline = Date.now() + stageTimeoutMs;

  const iterator = iterateSseEvents(stream);

  const abortIfNeeded = (): void => {
    if (options.signal?.aborted) {
      throw new IndexApiError('SSE stream aborted by caller', {
        endpoint,
        status: null,
      });
    }
  };

  try {
    for (;;) {
      abortIfNeeded();
      if (Date.now() > overallDeadline) {
        throw new IndexApiError('SSE stream overall timeout exceeded', {
          endpoint,
          status: null,
        });
      }
      if (Date.now() > stageDeadline) {
        throw new IndexApiError('SSE stream stage timeout exceeded', {
          endpoint,
          status: null,
        });
      }

      // Race the next event vs. a stage-timer so a wedged upstream cannot pin
      // us here forever. The race resolver distinguishes "stream drained" from
      // "timer fired" via the `_timeout` marker so the loop can throw the
      // right error class.
      const timeRemainingForStage = Math.max(0, stageDeadline - Date.now());
      const timeRemainingOverall = Math.max(0, overallDeadline - Date.now());
      const raceMs = Math.min(timeRemainingForStage, timeRemainingOverall);

      type RaceOutcome =
        | { kind: 'event'; value: SseEvent }
        | { kind: 'end' }
        | { kind: 'timeout' };

      const next: RaceOutcome = await Promise.race<RaceOutcome>([
        iterator.next().then((r): RaceOutcome => (r.done ? { kind: 'end' } : { kind: 'event', value: r.value })),
        new Promise<RaceOutcome>((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), raceMs + 25);
        }),
      ]);

      if (next.kind === 'timeout') {
        throw new IndexApiError('SSE stream stage timeout exceeded', {
          endpoint,
          status: null,
        });
      }
      if (next.kind === 'end') {
        break;
      }
      const evt = next.value;
      stageDeadline = Date.now() + stageTimeoutMs;

      if (evt.event === 'progress') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(evt.data);
        } catch (err) {
          console.warn(`[renaiss-index] SSE progress JSON parse failed:`, err);
          continue;
        }
        const validated = pipelineProgressSchema.safeParse(parsed);
        if (!validated.success) {
          console.warn(
            `[renaiss-index] SSE progress schema validation failed:`,
            validated.error.message
          );
          continue;
        }
        try {
          onProgress?.(validated.data);
        } catch (err) {
          // A misbehaving progress consumer must not tear down the stream.
          console.warn(`[renaiss-index] onProgress threw:`, err);
        }
        continue;
      }

      if (evt.event === 'result' || evt.event === 'done') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(evt.data);
        } catch (err) {
          throw new IndexApiError('SSE result payload was not valid JSON', {
            endpoint,
            status: null,
            cause: err,
          });
        }
        const validated = indexGradedSchema.safeParse(parsed);
        if (!validated.success) {
          throw new IndexApiError(
            'SSE result payload failed schema validation',
            { endpoint, status: null, cause: validated.error }
          );
        }
        resolvedResult = {
          ...validated.data,
          _disclosure: INDEX_BETA_DISCLOSURE,
        };
        // Do NOT break — some upstreams send a trailing empty frame after
        // `result`. We defer the break until iterator drains or timeout.
        break;
      }

      if (evt.event === 'failed' || evt.event === 'error') {
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(evt.data);
        } catch {
          // fall through with empty object
        }
        const validated = failedSchema.safeParse(parsed);
        sawFailed = {
          error: validated.success && validated.data.error ? validated.data.error : 'unknown_error',
          detail:
            validated.success && validated.data.detail
              ? validated.data.detail
              : 'Upstream returned a failed event without detail.',
        };
        break;
      }

      // Unknown event type: log and keep going. Upstream may add new frames.
      console.warn(`[renaiss-index] SSE unknown event="${evt.event}"`);
    }
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // best-effort
    }
  }

  if (sawFailed !== null) {
    throw new IndexApiError(
      `Upstream pipeline reported failure: ${sawFailed.error}`,
      {
        endpoint,
        status: null,
        cause: sawFailed.detail,
      }
    );
  }
  if (resolvedResult === null) {
    throw new IndexApiError('SSE stream ended without a result event', {
      endpoint,
      status: null,
    });
  }
  return resolvedResult;
};

// Test-only re-export for unit tests that want to exercise the low-level
// event iterator directly against a mock ReadableStream.
export const __test = { iterateSseEvents };

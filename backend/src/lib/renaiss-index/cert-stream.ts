/**
 * M9: SSE cert streaming with a resilient fallback to the cached, sync path.
 *
 * The stream endpoint is best-effort. If it 5xx's twice in a row across the
 * process lifetime we back off to `getOrFetchCert` (the cached sync lookup)
 * for a bounded cool-down window. This keeps the demo path fast even when
 * the upstream stream service is flapping.
 */

import { getOrFetchCert } from './cache.ts';
import { renaissIndex } from './client.ts';
import { IndexApiError } from './errors.ts';
import type { ProgressCallback } from './sse.ts';
import type { IndexGraded } from './types.ts';

const LOG_PREFIX = '[renaiss-index]';

const COOL_DOWN_MS = 60_000; // 60 seconds
const FAILURE_THRESHOLD = 2;

interface FailureState {
  consecutive5xx: number;
  coolDownUntil: number;
}

const state: FailureState = {
  consecutive5xx: 0,
  coolDownUntil: 0,
};

const isServerError = (err: unknown): boolean => {
  if (err instanceof IndexApiError) {
    const status = err.status;
    return status === null || (typeof status === 'number' && status >= 500);
  }
  return true; // network / abort - treat as server error for backoff purposes
};

/**
 * Attempt to stream the cert lookup. On repeated 5xx failures, fall back to
 * the cached sync `getOrFetchCert` path.
 *
 * `onProgress` will only fire when the stream path is used. Fallback returns
 * the cached / sync result with no progress events.
 */
export const streamCertWithFallback = async (
  cert: string,
  onProgress?: ProgressCallback
): Promise<{ result: IndexGraded; streamed: boolean }> => {
  if (Date.now() < state.coolDownUntil) {
    console.warn(
      `${LOG_PREFIX} SSE cert cool-down active; using sync path for cert=${cert}`
    );
    const result = await getOrFetchCert(cert);
    return { result, streamed: false };
  }

  try {
    const result = await renaissIndex.streamGradedByCert(cert, onProgress);
    // Reset failure counter on success.
    state.consecutive5xx = 0;
    return { result, streamed: true };
  } catch (err) {
    if (isServerError(err)) {
      state.consecutive5xx += 1;
      console.warn(
        `${LOG_PREFIX} SSE cert stream failed (${state.consecutive5xx}/${FAILURE_THRESHOLD}) cert=${cert}`
      );
      if (state.consecutive5xx >= FAILURE_THRESHOLD) {
        state.coolDownUntil = Date.now() + COOL_DOWN_MS;
        state.consecutive5xx = 0;
        console.warn(
          `${LOG_PREFIX} SSE cert cool-down engaged until ${new Date(state.coolDownUntil).toISOString()}`
        );
      }
      // Fall back to the sync cached path. Preserve UX by returning a result.
      const result = await getOrFetchCert(cert);
      return { result, streamed: false };
    }
    // 4xx or validation error: bubble up so callers can render "not found".
    throw err;
  }
};

/**
 * Test-only. Resets the module-level failure state between tests.
 */
export const __resetStreamCertState = (): void => {
  state.consecutive5xx = 0;
  state.coolDownUntil = 0;
};

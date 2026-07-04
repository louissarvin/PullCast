/**
 * Renaiss Index photo valuation client.
 *
 * Wraps POST /v1/graded/by-image. The upload is multipart/form-data with a
 * single `file` field; the response is a Server-Sent Events stream that
 * carries pipeline progress and a terminal `result` with the GradedLookup
 * payload.
 *
 * Guardrails (defense in depth against a malicious or malformed upload):
 *   1. File size ceiling (15 MB, matches upstream ceiling from the OpenAPI).
 *   2. MIME allowlist (JPEG / PNG / WebP / AVIF / HEIC), enforced BEFORE any
 *      network I/O — the upstream would 400 anyway but we do not want to burn
 *      a rate-limit slot on obviously-bad input.
 *   3. Per-stage + overall timeouts owned by the SSE consumer.
 */

import { RENAISS_INDEX_BASE } from '../../config/main-config.ts';
import { IndexApiError } from './errors.ts';
import { buildIndexAuthHeaders } from './index-headers.ts';
import {
  consumeGradedSseStream,
  type ProgressCallback,
} from './sse.ts';
import type { IndexGraded } from './types.ts';

const LOG_PREFIX = '[renaiss-index]';

/**
 * Local timeout budget for the initial POST /v1/graded/by-image fetch.
 *
 *   REQUEST_TIMEOUT_MS  — ceiling for the TCP handshake + TLS + first-byte
 *                         phase (before the SSE stream starts). Mirrors the
 *                         8s stage timer inside the SSE consumer.
 *   OVERALL_TIMEOUT_MS  — global ceiling that the initial fetch shares with
 *                         the SSE stream. If the initial fetch is slow, the
 *                         SSE consumer inherits the remaining budget via
 *                         `overallTimeoutMs` — but we still need a local
 *                         controller so a hung TCP connection cannot pin the
 *                         Fastify worker indefinitely when the caller did
 *                         not pass a signal.
 *
 * Pattern mirrored from `backend/cli/src/http.ts`.
 */
export const PHOTO_REQUEST_TIMEOUT_MS = 8_000;
export const PHOTO_OVERALL_TIMEOUT_MS = 60_000;
// Kept as internal aliases for readability inside this file.
const REQUEST_TIMEOUT_MS = PHOTO_REQUEST_TIMEOUT_MS;
const OVERALL_TIMEOUT_MS = PHOTO_OVERALL_TIMEOUT_MS;

export const PHOTO_MAX_BYTES = 15 * 1024 * 1024; // 15 MB per upstream OpenAPI

export const PHOTO_ALLOWED_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/pjpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
] as const;

const PHOTO_ENDPOINT = '/graded/by-image';

export const isAllowedPhotoMime = (mime: string | undefined | null): boolean => {
  if (typeof mime !== 'string' || mime.length === 0) return false;
  return PHOTO_ALLOWED_MIME_TYPES.includes(mime.toLowerCase());
};

export interface ValuateByImageOptions {
  onProgress?: ProgressCallback;
  /** Overall stream ceiling. Defaults to 60s per the task brief. */
  overallTimeoutMs?: number;
  /** Between-frame ceiling. Defaults to 8s per the task brief. */
  stageTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Value a graded card from a photo. Streams SSE progress via `onProgress`,
 * then resolves with the terminal GradedLookup payload.
 *
 * Throws `IndexApiError` on validation failure, non-2xx upstream response,
 * timeout, or a `failed` event.
 */
export const valuateByImage = async (
  buffer: Buffer,
  filename: string,
  mimeType: string,
  options: ValuateByImageOptions = {}
): Promise<IndexGraded> => {
  if (!buffer || buffer.length === 0) {
    throw new IndexApiError('valuateByImage requires a non-empty buffer', {
      status: null,
      endpoint: PHOTO_ENDPOINT,
    });
  }
  if (buffer.length > PHOTO_MAX_BYTES) {
    throw new IndexApiError(
      `Photo exceeds ${PHOTO_MAX_BYTES} bytes (${buffer.length}).`,
      { status: null, endpoint: PHOTO_ENDPOINT }
    );
  }
  if (!isAllowedPhotoMime(mimeType)) {
    throw new IndexApiError(
      `Unsupported photo mime type: ${mimeType}. Allowed: ${PHOTO_ALLOWED_MIME_TYPES.join(', ')}.`,
      { status: null, endpoint: PHOTO_ENDPOINT }
    );
  }
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new IndexApiError('valuateByImage requires a non-empty filename', {
      status: null,
      endpoint: PHOTO_ENDPOINT,
    });
  }

  // Neutralize the filename so a maliciously-crafted name (e.g. one with a
  // path or CRLF) cannot smuggle headers into the multipart boundary. We keep
  // the extension for the upstream MIME sniffer but strip everything else.
  const safeFilename = filename
    .replace(/[\r\n]/g, '')
    .split(/[\\/]/)
    .pop()!
    .slice(0, 200);

  const base = RENAISS_INDEX_BASE.replace(/\/+$/, '');
  const url = `${base}${PHOTO_ENDPOINT}`;

  // Native FormData + Blob. Bun / Node 20+ both support this without a polyfill.
  // Cast to Uint8Array<ArrayBuffer> for Blob compatibility.
  const blob = new Blob(
    [new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)],
    {
      type: mimeType.toLowerCase(),
    }
  );
  const formData = new FormData();
  formData.append('file', blob, safeFilename);

  // D8 MAJOR #5: local timeout on the initial fetch. Without this a hung TCP
  // connection to Renaiss would pin here indefinitely when the caller did not
  // pass a signal (the SSE stage/overall timers only kick in once the stream
  // starts). We chain any caller-supplied signal via a listener so both sides
  // can abort. Pattern mirrored from cli/src/http.ts.
  const localController = new AbortController();
  const localTimer = setTimeout(() => localController.abort(), REQUEST_TIMEOUT_MS);
  let externalAbortHandler: (() => void) | null = null;
  if (options.signal) {
    if (options.signal.aborted) {
      localController.abort();
    } else {
      externalAbortHandler = (): void => localController.abort();
      options.signal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildIndexAuthHeaders({ accept: 'text/event-stream' }),
      body: formData,
      signal: localController.signal,
    });
  } catch (err) {
    // Distinguish local-timer abort from caller abort so the error message is
    // honest. If the caller's own signal fired, we surface that; otherwise the
    // local 8s ceiling is the cause.
    const isCallerAbort = options.signal?.aborted === true;
    const message = isCallerAbort
      ? 'valuateByImage aborted by caller'
      : localController.signal.aborted
        ? `valuateByImage initial fetch exceeded ${REQUEST_TIMEOUT_MS}ms`
        : 'valuateByImage network request failed';
    throw new IndexApiError(message, {
      status: null,
      endpoint: PHOTO_ENDPOINT,
      cause: err,
    });
  } finally {
    clearTimeout(localTimer);
    if (externalAbortHandler && options.signal) {
      options.signal.removeEventListener('abort', externalAbortHandler);
    }
  }

  if (!res.ok || res.body === null) {
    let bodySnippet = '';
    try {
      bodySnippet = (await res.text()).slice(0, 500);
    } catch {
      // ignore
    }
    throw new IndexApiError(`valuateByImage upstream returned ${res.status}`, {
      status: res.status,
      endpoint: PHOTO_ENDPOINT,
      cause: bodySnippet,
    });
  }

  console.log(
    `${LOG_PREFIX} valuateByImage streaming filename=${safeFilename} size=${buffer.length} mime=${mimeType}`
  );

  return consumeGradedSseStream(res.body, {
    endpoint: PHOTO_ENDPOINT,
    onProgress: options.onProgress,
    overallTimeoutMs: options.overallTimeoutMs ?? OVERALL_TIMEOUT_MS,
    stageTimeoutMs: options.stageTimeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
  });
};

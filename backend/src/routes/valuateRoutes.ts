/**
 * /api/valuate/* REST routes (D6 M1 + M9).
 *
 *   POST /api/valuate/photo          multipart photo -> SSE / JSON envelope
 *   POST /api/valuate/cert/:cert     non-streaming cert lookup (API parity)
 *
 * Rate limit: per-IP token bucket (6/min) via `consumeRateLimitToken`. The
 * task brief mentions `@fastify/rate-limit` but the project already ships an
 * atomic Postgres-backed limiter (`lib/rate-limit.ts`); we reuse it so both
 * the Discord and HTTP surfaces share one budget model.
 *
 * Response envelope (both endpoints): the canonical PullCast envelope shape
 * built via `buildEnvelope` in src/utils/envelope.ts. See that file for the
 * exact contract. The SSE terminal `result` frame carries the same envelope.
 *
 * On SSE (`Accept: text/event-stream`) the endpoint pipes the upstream
 * pipeline progress to the client verbatim; the final `result` frame carries
 * the same envelope shape as the JSON response so both consumers see the same
 * marker set.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import fastifyMultipart from '@fastify/multipart';

import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import {
  getOrFetchCert,
  IndexApiError,
  IndexApiBudgetError,
} from '../lib/renaiss-index/index.ts';
import {
  PHOTO_ALLOWED_MIME_TYPES,
  PHOTO_MAX_BYTES,
  isAllowedPhotoMime,
  valuateByImage,
} from '../lib/renaiss-index/photo.ts';
import type { PipelineProgress } from '../lib/renaiss-index/sse.ts';
import {
  buildEnvelope,
  type EnvelopeSource,
} from '../utils/envelope.ts';
import { handleError } from '../utils/errorHandler.ts';
import { validateCert } from '../utils/paramValidators.ts';

const LOG_PREFIX = '[valuate]';

const clientIp = (request: FastifyRequest): string => {
  const ip = request.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  return 'unknown';
};

const consumeValuateToken = async (request: FastifyRequest): Promise<boolean> => {
  return consumeRateLimitToken(`http:ip:${clientIp(request)}:valuate`, 6, 6);
};

const renderTooManyRequests = (reply: FastifyReply): Promise<FastifyReply> =>
  handleError(reply, 429, 'Too many requests', 'RATE_LIMITED');

/**
 * SSE writer helper: format one frame and write it. Enforces cross-platform
 * line endings (CRLF) recommended by the SSE spec.
 */
const writeSseFrame = (reply: FastifyReply, event: string, data: unknown): void => {
  const raw = reply.raw;
  if (raw.destroyed) return;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  // Split multi-line payloads over multiple `data:` lines per SSE spec.
  const dataLines = payload
    .split(/\r?\n/)
    .map((line) => `data: ${line}`)
    .join('\r\n');
  raw.write(`event: ${event}\r\n${dataLines}\r\n\r\n`);
};

/**
 * Test whether the client asked for SSE. Falls back to JSON when the header
 * is absent or the client prefers JSON.
 */
const wantsSse = (request: FastifyRequest): boolean => {
  const accept = request.headers.accept;
  if (typeof accept !== 'string' || accept.length === 0) return false;
  const parts = accept.toLowerCase().split(',').map((p) => p.split(';')[0].trim());
  return parts.includes('text/event-stream');
};

export const valuateRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // Encapsulated multipart registration keeps the 15 MB ceiling scoped to
  // this route file — other routes keep the tight 16 KB body limit set at
  // the app level.
  app.register(fastifyMultipart, {
    limits: {
      fileSize: PHOTO_MAX_BYTES,
      files: 1,
      fields: 0,
      headerPairs: 20,
    },
  });

  // -------------------------------------------------------------------
  // POST /api/valuate/photo
  // -------------------------------------------------------------------
  app.post('/photo', async (request, reply) => {
    if (!(await consumeValuateToken(request))) return renderTooManyRequests(reply);

    if (!request.isMultipart()) {
      return handleError(
        reply,
        400,
        'Content-Type must be multipart/form-data with a `file` field.',
        'INVALID_CONTENT_TYPE'
      );
    }

    let filePart;
    try {
      filePart = await request.file();
    } catch (err) {
      // @fastify/multipart throws typed errors (e.g. RequestFileTooLargeError).
      const anyErr = err as { code?: string; message?: string };
      if (anyErr?.code === 'FST_REQ_FILE_TOO_LARGE') {
        return handleError(
          reply,
          413,
          `File exceeds ${PHOTO_MAX_BYTES} bytes.`,
          'FILE_TOO_LARGE'
        );
      }
      console.warn(`${LOG_PREFIX} multipart parse failed:`, err);
      return handleError(
        reply,
        400,
        'Malformed multipart upload.',
        'INVALID_MULTIPART'
      );
    }

    if (!filePart) {
      return handleError(reply, 400, 'Missing `file` field.', 'MISSING_FILE');
    }
    if (!isAllowedPhotoMime(filePart.mimetype)) {
      // Drain the stream so the connection is not left half-open.
      try {
        filePart.file.resume();
      } catch {
        // ignore
      }
      return handleError(
        reply,
        415,
        `Unsupported mime type: ${filePart.mimetype}. Allowed: ${PHOTO_ALLOWED_MIME_TYPES.join(', ')}.`,
        'UNSUPPORTED_MEDIA_TYPE'
      );
    }

    let buffer: Buffer;
    try {
      buffer = await filePart.toBuffer();
    } catch (err) {
      const anyErr = err as { code?: string };
      if (anyErr?.code === 'FST_REQ_FILE_TOO_LARGE') {
        return handleError(
          reply,
          413,
          `File exceeds ${PHOTO_MAX_BYTES} bytes.`,
          'FILE_TOO_LARGE'
        );
      }
      console.warn(`${LOG_PREFIX} filePart.toBuffer failed:`, err);
      return handleError(
        reply,
        400,
        'Failed to read uploaded file.',
        'INVALID_MULTIPART'
      );
    }

    if (buffer.length === 0) {
      return handleError(reply, 400, 'Empty file.', 'MISSING_FILE');
    }
    if (buffer.length > PHOTO_MAX_BYTES) {
      return handleError(
        reply,
        413,
        `File exceeds ${PHOTO_MAX_BYTES} bytes.`,
        'FILE_TOO_LARGE'
      );
    }

    const sources: EnvelopeSource[] = [
      {
        label: 'Renaiss OS Index (beta)',
        url: 'https://api.renaissos.com/v1/graded/by-image',
      },
    ];

    if (wantsSse(request)) {
      // SSE mode: forward pipeline progress live.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // hint for nginx not to buffer
      });

      // D8-M-1 (security): propagate client disconnect to the upstream fetch
      // so a client that opens then hangs up does not tie up a photo pipeline
      // and burn the daily Index API budget slot. `valuateByImage` threads
      // this signal into both the outbound fetch and the SSE stream consumer.
      const controller = new AbortController();
      const onClientClose = (): void => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
        try {
          raw.end();
        } catch {
          // ignore
        }
      };
      request.raw.on('close', onClientClose);

      try {
        const result = await valuateByImage(
          buffer,
          filePart.filename ?? 'upload.bin',
          filePart.mimetype,
          {
            onProgress: (progress: PipelineProgress) => {
              writeSseFrame(raw as unknown as FastifyReply, 'progress', progress);
            },
            signal: controller.signal,
          }
        );
        const envelope = buildEnvelope(result, { sources });
        writeSseFrame(raw as unknown as FastifyReply, 'result', envelope);
      } catch (err) {
        const payload =
          err instanceof IndexApiError
            ? { code: 'UPSTREAM_ERROR', message: err.message }
            : { code: 'INTERNAL_ERROR', message: 'Unexpected error.' };
        writeSseFrame(raw as unknown as FastifyReply, 'failed', payload);
        console.error(`${LOG_PREFIX} SSE photo pipeline failed:`, err);
      } finally {
        request.raw.off('close', onClientClose);
        try {
          raw.end();
        } catch {
          // ignore
        }
      }
      return;
    }

    // JSON mode: buffer the pipeline to completion and return the envelope.
    try {
      const result = await valuateByImage(
        buffer,
        filePart.filename ?? 'upload.bin',
        filePart.mimetype
      );
      return reply.code(200).send(buildEnvelope(result, { sources }));
    } catch (err) {
      if (err instanceof IndexApiBudgetError) {
        return handleError(
          reply,
          429,
          'Daily budget exhausted for the Renaiss Index API. Try again tomorrow.',
          'BUDGET_EXHAUSTED',
          err
        );
      }
      if (err instanceof IndexApiError) {
        console.warn(`${LOG_PREFIX} photo pipeline failed:`, err.message);
        return handleError(
          reply,
          502,
          'Renaiss Index API pipeline failed. Try again in a moment.',
          'UPSTREAM_UNAVAILABLE',
          err
        );
      }
      console.error(`${LOG_PREFIX} photo pipeline unexpected error:`, err);
      return handleError(
        reply,
        500,
        'Unexpected internal error.',
        'INTERNAL_ERROR',
        err instanceof Error ? err : null
      );
    }
  });

  // -------------------------------------------------------------------
  // POST /api/valuate/cert/:cert   (non-streaming wrapper)
  // -------------------------------------------------------------------
  app.post(
    '/cert/:cert',
    async (
      request: FastifyRequest<{ Params: { cert: string } }>,
      reply: FastifyReply
    ) => {
      if (!(await consumeValuateToken(request))) return renderTooManyRequests(reply);

      const cert = validateCert(request.params.cert);
      if (cert === null) {
        return handleError(
          reply,
          400,
          'Invalid cert. Format: PSA/BGS/CGC/SGC + 6-12 digits.',
          'INVALID_PARAM'
        );
      }

      const sources: EnvelopeSource[] = [
        {
          label: 'Renaiss OS Index (beta)',
          url: `https://api.renaissos.com/v1/graded/${encodeURIComponent(cert)}`,
        },
      ];

      try {
        const result = await getOrFetchCert(cert);
        return reply.code(200).send(buildEnvelope(result, { sources }));
      } catch (err) {
        if (err instanceof IndexApiBudgetError) {
          return handleError(
            reply,
            429,
            'Daily budget exhausted for the Renaiss Index API. Try again tomorrow.',
            'BUDGET_EXHAUSTED',
            err
          );
        }
        if (err instanceof IndexApiError) {
          console.warn(`${LOG_PREFIX} cert lookup failed cert=${cert} status=${err.status}`);
          return handleError(
            reply,
            502,
            'Renaiss Index API unreachable',
            'UPSTREAM_UNAVAILABLE',
            err
          );
        }
        console.error(`${LOG_PREFIX} cert lookup unexpected cert=${cert}:`, err);
        return handleError(
          reply,
          500,
          'Unexpected internal error.',
          'INTERNAL_ERROR',
          err instanceof Error ? err : null
        );
      }
    }
  );

  done();
};

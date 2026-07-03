/**
 * Health + readiness endpoints.
 *
 * `GET /health`     - basic liveness + the data the ops dashboard cares about:
 *                     uptimeSec, indexer last-success, discord readiness, git
 *                     sha. No auth, no DB hit required for liveness.
 * `GET /health/db`  - DB ping. 200 either way; the client reads `db: 'ok'|'fail'`
 *                     from the body rather than the HTTP status code (per brief).
 *
 * No rate limiting on health (load balancers and uptime monitors poll these).
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { GIT_SHA, RENAISS_INDEX_BASE } from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { getDiscordClient } from '../lib/discord/index.ts';
import { renaissApi } from '../lib/renaiss/index.ts';
import { getBscProvider } from '../lib/ethers/index.ts';
import { buildEnvelope } from '../utils/envelope.ts';

const LOG_PREFIX = '[health]';

const PROCESS_STARTED_AT_MS = Date.now();

const getUptimeSec = (): number => {
  return Math.floor((Date.now() - PROCESS_STARTED_AT_MS) / 1000);
};

/**
 * Fetch the most-recent successful indexer poll timestamp across all tracked
 * packs. Returns null if no Cursor row has ever recorded a success.
 */
const getIndexerLastSuccessAt = async (): Promise<Date | null> => {
  try {
    const row = await prismaQuery.cursor.findFirst({
      where: { deletedAt: null, lastSuccessfulPollAt: { not: null } },
      orderBy: { lastSuccessfulPollAt: 'desc' },
      select: { lastSuccessfulPollAt: true },
    });
    return row?.lastSuccessfulPollAt ?? null;
  } catch (err) {
    console.warn(`${LOG_PREFIX} cursor lookup failed:`, err);
    return null;
  }
};

/**
 * Discord ready when the cached client (singleton) is fully logged in.
 * `client.isReady()` is a discord.js v14 method that returns true once the
 * gateway has finished the READY handshake.
 */
const isDiscordReady = (): boolean => {
  try {
    const client = getDiscordClient();
    return client.isReady();
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// /health/upstream helpers
// ---------------------------------------------------------------------------

interface UpstreamStatus {
  ok: boolean;
  status?: string | null;
  timestamp?: string | null;
  latency_ms?: number;
  error?: string;
}

const UPSTREAM_CACHE_TTL_MS = 30 * 1000; // 30s per requirement
const UPSTREAM_HEALTH_TIMEOUT_MS = 2000;

let upstreamCache: { storedAt: number; envelope: unknown } | null = null;

const getUpstreamCache = (): unknown | null => {
  if (upstreamCache === null) return null;
  if (Date.now() - upstreamCache.storedAt > UPSTREAM_CACHE_TTL_MS) {
    upstreamCache = null;
    return null;
  }
  return upstreamCache.envelope;
};

const putUpstreamCache = (envelope: unknown): void => {
  upstreamCache = { storedAt: Date.now(), envelope };
};

/**
 * Test-only reset. Exported for `tests/health-upstream.test.ts` so cache TTL
 * behavior can be exercised deterministically.
 */
export const __resetUpstreamCacheForTests = (): void => {
  upstreamCache = null;
};

const settledToStatus = (
  res: PromiseSettledResult<UpstreamStatus>
): UpstreamStatus => {
  if (res.status === 'fulfilled') return res.value;
  const reason = res.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  return { ok: false, error: message.slice(0, 200) };
};

const checkRenaissMainHealth = async (): Promise<UpstreamStatus> => {
  const result = await renaissApi.getHealth();
  if (result.ok) {
    return {
      ok: true,
      status: result.status,
      timestamp: result.timestamp,
      latency_ms: result.latencyMs,
    };
  }
  return { ok: false, error: result.error, latency_ms: result.latencyMs };
};

/**
 * Renaiss Index API health probe. Local implementation instead of a method on
 * `renaissIndex` because the shared client lives in `src/lib/renaiss-index/`
 * which another agent is co-editing this sprint. Same 2s timeout, no retry.
 * Live shape (2026-07-03): `{ ok: true, db: true, rateLimit: true, internalAuth: true }`.
 */
const checkRenaissIndexHealth = async (): Promise<UpstreamStatus> => {
  const url = `${RENAISS_INDEX_BASE.replace(/\/+$/, '')}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_HEALTH_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'pullcast-backend/0.1 (+https://github.com/pullcast)',
      },
    });
    const latency_ms = Date.now() - startedAt;
    if (!res.ok) {
      return { ok: false, error: `upstream_${res.status}`, latency_ms };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const root = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {});
    const ok = root.ok === true;
    // Live upstream does not send a `status` string, only a boolean `ok`. We
    // synthesize a short status label for parity with the main API surface.
    return {
      ok,
      status: ok ? 'ok' : 'degraded',
      latency_ms,
    };
  } catch (err) {
    const latency_ms = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.slice(0, 200), latency_ms };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * BSC RPC health via the existing FallbackProvider. A successful
 * `getBlockNumber()` call proves at least one peer is reachable, since the
 * FallbackProvider transparently fails over on stall.
 *
 * We wrap with a hard 2s wall-clock timeout so a stuck provider still returns
 * a fail-fast status to the operator instead of hanging the health endpoint.
 */
const checkBscRpcHealth = async (): Promise<UpstreamStatus> => {
  const startedAt = Date.now();
  try {
    const provider = getBscProvider();
    const blockNumber = await Promise.race<number>([
      provider.getBlockNumber(),
      new Promise<number>((_, reject) =>
        setTimeout(
          () => reject(new Error('bsc_rpc_timeout')),
          UPSTREAM_HEALTH_TIMEOUT_MS
        )
      ),
    ]);
    const latency_ms = Date.now() - startedAt;
    if (!Number.isFinite(blockNumber) || blockNumber <= 0) {
      return { ok: false, error: 'invalid_block_number', latency_ms };
    }
    return {
      ok: true,
      status: `block=${blockNumber}`,
      latency_ms,
    };
  } catch (err) {
    const latency_ms = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.slice(0, 200), latency_ms };
  }
};

export const healthRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const indexerLastSuccessAt = await getIndexerLastSuccessAt();
    const payload = {
      status: 'ok',
      uptimeSec: getUptimeSec(),
      indexerLastSuccessAt:
        indexerLastSuccessAt !== null ? indexerLastSuccessAt.toISOString() : null,
      discordReady: isDiscordReady(),
      ...(GIT_SHA !== null ? { gitSha: GIT_SHA } : {}),
    };
    return reply.code(200).send({ success: true, error: null, data: payload });
  });

  app.get('/health/upstream', async (_request: FastifyRequest, reply: FastifyReply) => {
    const cached = getUpstreamCache();
    if (cached !== null) {
      return reply.code(200).send(cached);
    }

    const [mainRes, indexRes, bscRes] = await Promise.allSettled([
      checkRenaissMainHealth(),
      checkRenaissIndexHealth(),
      checkBscRpcHealth(),
    ]);

    const payload = {
      renaiss_main: settledToStatus(mainRes),
      renaiss_index: settledToStatus(indexRes),
      bsc_rpc: settledToStatus(bscRes),
    };

    const envelope = buildEnvelope(payload, {
      // No canonical `SOURCE_*` for a self-health endpoint; sources array
      // stays empty rather than misrepresenting upstream provenance.
      sources: [],
    });
    putUpstreamCache(envelope);
    return reply.code(200).send(envelope);
  });

  app.get('/health/db', async (_request: FastifyRequest, reply: FastifyReply) => {
    let dbStatus: 'ok' | 'fail' = 'fail';
    try {
      // $queryRawUnsafe accepts a literal SQL string; we pass a fixed constant
      // (no interpolation) so injection is not a concern. Using $queryRaw with
      // template literal would also work but Prisma requires Prisma.sql there.
      await prismaQuery.$queryRawUnsafe('SELECT 1');
      dbStatus = 'ok';
    } catch (err) {
      console.warn(`${LOG_PREFIX} db ping failed:`, err);
      dbStatus = 'fail';
    }
    // 200 either way per the brief; clients read the `db` field.
    return reply.code(200).send({ success: true, error: null, data: { db: dbStatus } });
  });

  done();
};

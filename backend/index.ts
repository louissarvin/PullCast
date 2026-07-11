import './dotenv.ts';

import cron from 'node-cron';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import FastifyCors from '@fastify/cors';
import { APP_PORT } from './src/config/main-config.ts';
import { prismaQuery } from './src/lib/prisma.ts';
import { redactSecrets } from './src/utils/redactSecrets.ts';

// Routes
import { exampletRoute } from './src/routes/exampleRoutes.ts';
import { healthRoutes } from './src/routes/healthRoutes.ts';
import { pullRoutes } from './src/routes/pullRoutes.ts';
import { priceRoutes } from './src/routes/priceRoutes.ts';
import { ogRoutes, warmOgPlaceholder } from './src/routes/ogRoutes.ts';
import { leaderboardRoutes } from './src/routes/leaderboardRoutes.ts';
import { oddsRoutes } from './src/routes/oddsRoutes.ts';
import { aiRoutes } from './src/routes/aiRoutes.ts';
import { marketRoutes } from './src/routes/marketRoutes.ts';
import { cardSlugRoutes } from './src/routes/cardSlugRoutes.ts';
import { marketplaceRoutes } from './src/routes/marketplaceRoutes.ts';
import { packsRoutes } from './src/routes/packsRoutes.ts';
import { valuateRoutes } from './src/routes/valuateRoutes.ts';
import { profileRoutes } from './src/routes/profileRoutes.ts';
import { reportRoutes } from './src/routes/reportRoutes.ts';
import { claudePluginRoutes } from './src/routes/claudePluginRoutes.ts';
import { renaissIdRoutes } from './src/routes/renaissIdRoutes.ts';
import { statsRoutes } from './src/routes/statsRoutes.ts';
import { tradesRoutes } from './src/routes/tradesRoutes.ts';

// Workers
import { startErrorLogCleanupWorker } from './src/workers/errorLogCleanup.ts';
import { setIndexerDiscordReady, startIndexerWorker } from './src/workers/indexer.ts';
import { startLeaderboardWorker } from './src/workers/leaderboard.ts';
import { startCardOfTheDayWorker } from './src/workers/cardOfTheDay.ts';
import { startBigTradeAlertWorker } from './src/workers/bigTradeAlert.ts';

// Discord
import {
  getDiscordClient,
  loginDiscord,
  registerCommands,
  wireCommandHandlers,
} from './src/lib/discord/index.ts';
import { ALL_COMMANDS } from './src/lib/discord/commands/index.ts';

// Share card warm-up
import { loadFonts } from './src/lib/share-card/fonts.ts';

console.log(
  '======================\n======================\nMY BACKEND SYSTEM STARTED!\n======================\n======================\n'
);

const fastify = Fastify({
  logger: false,
  trustProxy: 1, // one hop: Cloudflare / Fly / Render / Railway
  bodyLimit: 16 * 1024, // L-10: cap request body at 16 KB
});

// M-2 + D8-M-2 (security): CORS scoping posture.
//
// `origin: '*'` is INTENTIONAL for the hackathon demo surface. Every /api/*
// endpoint today is:
//   - unauthenticated (no cookie, no Authorization header),
//   - read-only or a non-PII spam-guarded POST (/api/report is 3/min per IP,
//     forwarded to an upstream moderation queue),
//   - rate-limited by the atomic Postgres bucket per IP,
//   - subject to daily upstream budget caps.
// Since there is no cookie / bearer surface, an attacker cannot leverage `*`
// to steal credentials via a cross-origin fetch — a third-party page can only
// scrape the same public read endpoints it could hit directly via curl.
//
// TODO(security): If any future PR adds an authenticated endpoint (e.g.
// `/api/me`, wallet-linked write path, or ANY endpoint that reads a session
// cookie or Authorization header), tighten this to an explicit allowlist,
// e.g. `origin: ['https://pullcast.xyz', 'https://www.pullcast.xyz']` and
// (crucially) do NOT set `credentials: true` with a wildcard origin — the
// browser will refuse the response. See:
//   - memory/d8-security-sweep.md D8-M-2
//   - OWASP REST Cheat Sheet — CORS section
//   - https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html#cors
fastify.register(FastifyCors, {
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
});

// Health check endpoint
fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
  return reply.status(200).send({
    success: true,
    message: 'Hello there!',
    error: null,
    data: null,
  });
});

// Register routes with prefixes
// Example: fastify.register(adminRoutes, { prefix: '/admin' })
// Example: fastify.register(userRoutes, { prefix: '/user' })
fastify.register(exampletRoute, { prefix: '/example' });
fastify.register(healthRoutes); // /health, /health/db
fastify.register(pullRoutes, { prefix: '/api' }); // /api/pulls, /api/pulls/:id, /api/wallets/:address/pulls
fastify.register(priceRoutes, { prefix: '/api/price' }); // /api/price/token/:id, /cert/:cert, /search
fastify.register(leaderboardRoutes, { prefix: '/api/leaderboard' }); // /api/leaderboard/daily, /history
fastify.register(statsRoutes, { prefix: '/api/stats' });
fastify.register(tradesRoutes, { prefix: '/api/trades' });
fastify.register(oddsRoutes, { prefix: '/api/odds' }); // /api/odds/:pack
fastify.register(aiRoutes, { prefix: '/api' }); // /api/explain, /api/listing
fastify.register(marketRoutes, { prefix: '/api' }); // /api/market, /api/market/:game, /api/featured
fastify.register(cardSlugRoutes, { prefix: '/api' }); // /api/sets/:game/:set, /api/cards/:game/:set/:card[...] , /api/cards/by-id/:id/series
fastify.register(marketplaceRoutes, { prefix: '/api' }); // /api/marketplace (filtered search)
fastify.register(packsRoutes, { prefix: '/api' }); // /api/packs, /api/packs/:slug
fastify.register(valuateRoutes, { prefix: '/api/valuate' }); // /api/valuate/photo, /api/valuate/cert/:cert
fastify.register(profileRoutes, { prefix: '/api/users' }); // /api/users/:uuid
fastify.register(reportRoutes, { prefix: '/api/report' }); // POST /api/report
fastify.register(ogRoutes); // /og/:pullId
fastify.register(claudePluginRoutes); // /claude-plugin/marketplace.json (root-level, no prefix)
fastify.register(renaissIdRoutes, { prefix: '/api/cards' }); // /api/cards/renaiss-id/:rid[/{overview,trades,series,fmv-series}]

const bootDiscord = async (): Promise<boolean> => {
  // Cap the entire Discord boot at 30s. A bad token causes discord.js to retry
  // forever silently; without this timeout, the whole process (including
  // Fastify) hangs and Railway's healthcheck fails. Better to boot the REST
  // API without Discord and let ops fix the token in the background.
  const DISCORD_BOOT_TIMEOUT_MS = 30_000;
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => {
      console.warn(
        `[boot] Discord login timed out after ${DISCORD_BOOT_TIMEOUT_MS}ms — proceeding without Discord. Check DISCORD_BOT_TOKEN.`
      );
      resolve(false);
    }, DISCORD_BOOT_TIMEOUT_MS);
  });
  const attempt = (async () => {
    try {
      await loginDiscord();
      const client = getDiscordClient();
      wireCommandHandlers(client, ALL_COMMANDS);
      await registerCommands(client, ALL_COMMANDS);
      return true;
    } catch (err) {
      console.warn(
        `[boot] Discord login failed, indexer + bot disabled: ${redactSecrets(err)}`
      );
      return false;
    }
  })();
  return Promise.race([attempt, timeout]);
};

const start = async (): Promise<void> => {
  try {
    // Boot-time diagnostic + cache warm-up. We serialize 5 upstream calls with
    // 500ms spacing so we never look bursty to Renaiss's edge. If any of these
    // return 200, they populate our in-process cache; subsequent user requests
    // hit the cache and don't touch upstream at all for 5-10 minutes.
    try {
      const { hasIndexPartnerAuth, buildIndexAuthHeaders } = await import(
        './src/lib/renaiss-index/index-headers.ts'
      );
      const authed = hasIndexPartnerAuth();
      const headers = buildIndexAuthHeaders();
      const headerKeys = Object.keys(headers).join(',');
      console.log(
        `[boot] renaiss-index partner_auth=${authed} headers_sent=[${headerKeys}]`
      );
      // Diagnostic: probe an echo endpoint to see the ACTUAL headers Bun's
      // fetch sends over the wire. If X-Api-Key/Secret are missing from the
      // echo response, Bun is stripping them before send.
      try {
        const echo = await fetch('https://postman-echo.com/get', {
          method: 'GET',
          headers,
        });
        const body = (await echo.json()) as { headers?: Record<string, string> }
        const h = body.headers ?? {}
        const wireKey = h['x-api-key'] ?? h['X-Api-Key'] ?? '<missing>'
        const wireSec = h['x-api-secret'] ?? h['X-Api-Secret'] ?? '<missing>'
        console.log(
          `[boot] wire echo -> x-api-key="${wireKey.slice(0, 8)}..." x-api-secret="${wireSec.slice(0, 8)}..." all_keys=[${Object.keys(h).join(',')}]`,
        );
      } catch (err) {
        console.warn(
          `[boot] wire echo failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (authed) {
        const {
          getCachedIndices,
          getCachedIndicesByGame,
          getCachedFeatured,
        } = await import('./src/lib/renaiss-index/market-cache.ts');
        const { renaissIndex } = await import('./src/lib/renaiss-index/client.ts');
        const sleepMs = (ms: number): Promise<void> =>
          new Promise((resolve) => setTimeout(resolve, ms));
        const tasks: Array<[string, () => Promise<unknown>]> = [
          ['indices', () => getCachedIndices()],
          ['indices/pokemon', () => getCachedIndicesByGame('pokemon')],
          ['indices/one-piece', () => getCachedIndicesByGame('one-piece')],
          ['featured?limit=24', () => getCachedFeatured(24)],
          ['trades/recent', () => renaissIndex.getRecentTrades({ limit: 24 })],
        ];
        for (const [label, task] of tasks) {
          try {
            await task();
            console.log(`[boot] warmed ${label} OK`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[boot] warmed ${label} FAILED: ${msg}`);
          }
          // 2s between warmup calls. Renaiss's edge appears to apply a
          // per-second burst limit even for partner-tier keys — dropping
          // us to public-tier responses when we exceed ~2 req/s.
          await sleepMs(2000);
        }
      }
    } catch (err) {
      console.warn(
        `[boot] renaiss-index warmup failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Workers that have no external deps go first.
    startErrorLogCleanupWorker();

    // Pre-warm the share-card font cache so the first real render is hot.
    await loadFonts().catch((err: unknown) => {
      console.warn(`[boot] loadFonts failed, share-card renders will be cold: ${redactSecrets(err)}`);
    });

    // Pre-render the OG placeholder PNG so first render-failure path is hot.
    await warmOgPlaceholder();

    // Discord boot is allowed to fail without crashing the server. The indexer
    // reads the resulting flag and short-circuits its fanout when false.
    const discordOk = await bootDiscord();
    setIndexerDiscordReady(discordOk);

    // Indexer always starts (even without Discord) so we still persist Pulls.
    startIndexerWorker();

    // Leaderboard worker is independent of Discord readiness; it only reads
    // Pull rows and writes LeaderboardSnapshot rows.
    startLeaderboardWorker();

    // D8: Card of the Day cron. Registers the schedule; does not fire on boot.
    startCardOfTheDayWorker();

    // D8: Big Trade Alert cron. Polls /v1/trades/recent every 5 min; posts
    // alert embeds to any Subscription.type = 'BIG_TRADE_ALERT' channel.
    startBigTradeAlertWorker();

    await fastify.listen({
      port: APP_PORT,
      host: '0.0.0.0',
    });

    const address = fastify.server.address();
    const port = typeof address === 'object' && address ? address.port : APP_PORT;

    console.log(`Server started successfully on port ${port}`);
    console.log(`http://localhost:${port}`);
  } catch (error) {
    console.log(`Error starting server: ${redactSecrets(error)}`);
    process.exit(1);
  }
};

// ---------------------------------------------------------------------------
// Graceful shutdown (D7).
//
// On SIGTERM (deploy rolling restart) or SIGINT (Ctrl-C in dev) we:
//   1. Stop accepting new HTTP requests (fastify.close drains in-flight).
//   2. Stop every node-cron task so the indexer / leaderboard worker do not
//      start a new tick mid-shutdown.
//   3. Wait up to 5s for in-flight indexer / Discord posts to settle.
//   4. Close the Prisma connection pool.
//
// A 10s hard timeout fires if the above stalls (e.g. a stuck connection),
// at which point we exit 1 so the process supervisor restarts us cleanly.
// ---------------------------------------------------------------------------
const SHUTDOWN_DRAIN_MS = 5000;
const SHUTDOWN_HARD_TIMEOUT_MS = 10_000;

let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[boot] received ${signal}, draining...`);

  // Hard ceiling: if anything below stalls, force-exit so the orchestrator
  // can replace us instead of hanging in a zombie state.
  const hardTimer = setTimeout(() => {
    console.error('[boot] shutdown exceeded 10s, forcing exit');
    process.exit(1);
  }, SHUTDOWN_HARD_TIMEOUT_MS);
  // Unref the timer so it does not by itself keep the event loop alive.
  if (typeof hardTimer.unref === 'function') {
    hardTimer.unref();
  }

  try {
    // 1. Stop accepting new HTTP requests; finishes in-flight handlers.
    await fastify.close();

    // 2. Stop every scheduled cron task so workers do not start a new tick.
    for (const task of cron.getTasks().values()) {
      try {
        task.stop();
      } catch (err) {
        console.warn(`[boot] cron task stop failed: ${redactSecrets(err)}`);
      }
    }

    // 3. Best-effort drain window for in-flight indexer poll / Discord post /
    //    AI call. We do not have explicit completion signals from those
    //    pipelines (Bronze scope); a bounded sleep is the pragmatic choice.
    await new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS));

    // 4. Close DB connections last so anything still using Prisma above can
    //    finish first.
    await prismaQuery.$disconnect();
  } catch (err) {
    console.error(`[boot] shutdown error: ${redactSecrets(err)}`);
  } finally {
    clearTimeout(hardTimer);
    process.exit(0);
  }
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

start();


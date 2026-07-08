/**
 * Claude Code plugin marketplace route.
 *
 *   GET /claude-plugin/marketplace.json
 *
 * Serves the static marketplace.json file at the root so users can install the
 * PullCast plugin with:
 *
 *   claude plugin marketplace add https://pullcast.xyz/claude-plugin/marketplace.json
 *   claude plugin install pullcast@pullcast
 *
 * Registered WITHOUT the `/api` prefix so the URL matches the literal in the
 * docs / README / ShipFlow parity requirement.
 *
 * Security posture:
 *  - Reads the file from disk once on module load and caches the JSON.
 *  - Sends a 60s Cache-Control so upstream CDNs can absorb load.
 *  - CORS is already permissive at the app level (`origin: '*'`), so we do not
 *    add per-route CORS overrides. If that changes, add explicit
 *    Access-Control-Allow-Origin here.
 *  - No user input reaches the filesystem read; the path is hardcoded.
 *  - If the file is missing / invalid JSON at boot, the route returns a 500
 *    with a generic message (details logged server-side).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { handleError } from '../utils/errorHandler.ts';

const LOG_PREFIX = '[claude-plugin]';

/**
 * Load marketplace.json from the repo root at module init.
 *
 * The path resolves relative to `process.cwd()`, which is the backend/ dir
 * when we run `bun index.ts` or `npm start` from backend/. This keeps the
 * file colocated with the CLI + SKILL for a single source of truth.
 */
let cachedMarketplaceJson: string | null = null;
let cachedMarketplaceObj: unknown = null;

const loadMarketplace = (): { text: string; obj: unknown } | null => {
  if (cachedMarketplaceJson !== null && cachedMarketplaceObj !== null) {
    return { text: cachedMarketplaceJson, obj: cachedMarketplaceObj };
  }
  try {
    const path = resolve(process.cwd(), 'marketplace.json');
    const raw = readFileSync(path, 'utf-8');
    // Validate it parses cleanly; a bad file means an ops issue not a client
    // issue, so we log loudly and refuse to serve garbage.
    const obj: unknown = JSON.parse(raw);
    cachedMarketplaceJson = raw;
    cachedMarketplaceObj = obj;
    return { text: raw, obj };
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to load marketplace.json:`, err);
    return null;
  }
};

// Prime the cache at import so a bad file crashes at boot instead of on the
// first request. If loading fails, requests fall through to a 500.
loadMarketplace();

export const claudePluginRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/claude-plugin/marketplace.json',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const loaded = loadMarketplace();
      if (!loaded) {
        return handleError(
          reply,
          500,
          'Marketplace metadata is temporarily unavailable',
          'MARKETPLACE_UNAVAILABLE'
        );
      }
      return reply
        .code(200)
        .header('content-type', 'application/json; charset=utf-8')
        .header('cache-control', 'public, max-age=60')
        .send(loaded.obj);
    }
  );

  done();
};

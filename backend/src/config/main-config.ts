/**
 * Centralized configuration for the application.
 * All commonly used environment variables should be defined here.
 *
 * Hard rule: no other file may read `process.env.X` directly.
 */

// Validate required environment variables on startup.
// For D1 we only hard-require the originals plus Discord + Anthropic credentials.
// Renaiss + BSC defaults are safe; the dev process should still boot without them.
const requiredEnvVars: string[] = [
  'DATABASE_URL',
  'JWT_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_APP_ID',
  'GROQ_API_KEY',
];

// Log which required env vars are missing (if any) BEFORE bailing out. This
// runs at module load time so it happens before Fastify or any worker boots.
// Use synchronous writes to stderr so the message flushes before process.exit
// in containerized environments where stdio buffering can eat error output.
const missing: string[] = requiredEnvVars.filter((v) => !process.env[v]);
if (missing.length > 0) {
  // D11: backwards-compat migration guard. If the operator still has the old
  // ANTHROPIC_API_KEY set but has not migrated to GROQ_API_KEY, refuse to
  // boot with a clear deprecation message.
  if (
    missing.includes('GROQ_API_KEY') &&
    typeof process.env.ANTHROPIC_API_KEY === 'string' &&
    process.env.ANTHROPIC_API_KEY.length > 0
  ) {
    process.stderr.write(
      '[config] DEPRECATED: ANTHROPIC_API_KEY is set but GROQ_API_KEY is missing. ' +
        'The AI provider has been swapped from Anthropic to Groq. ' +
        'Set GROQ_API_KEY (get one at https://console.groq.com/keys) and remove ANTHROPIC_API_KEY. ' +
        'Refusing to boot.\n'
    );
    process.exit(1);
  }
  process.stderr.write(
    `FATAL: Missing required environment variables: ${missing.join(', ')}\n` +
      `Set them via 'railway variables --set KEY=value' and redeploy.\n`
  );
  process.exit(1);
}
process.stderr.write('[boot] required env vars present\n');

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
// Port resolution order:
//   1. APP_PORT — our explicit override (set on Railway to 3700 for /health matching)
//   2. PORT     — Railway/Heroku/Fly convention; auto-injected by the platform
//   3. 3700     — dev default
export const APP_PORT: number =
  Number(process.env.APP_PORT) || Number(process.env.PORT) || 3700;
// M-1: default to production. Dev mode is the explicit opt-in via NODE_ENV=development.
// This guards against demo boxes / Fly / Render free tier deployments forgetting
// to set NODE_ENV, which would otherwise leak stack traces through errorHandler.
export const NODE_ENV: string = process.env.NODE_ENV || 'production';
export const IS_DEV: boolean = NODE_ENV === 'development';
export const IS_PROD: boolean = NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
export const DATABASE_URL: string = process.env.DATABASE_URL as string;

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
export const JWT_SECRET: string = process.env.JWT_SECRET as string;
export const JWT_EXPIRES_IN: string = process.env.JWT_EXPIRES_IN || '7d';

// ---------------------------------------------------------------------------
// Error Log
// ---------------------------------------------------------------------------
export const ERROR_LOG_MAX_RECORDS: number = 10000;
export const ERROR_LOG_CLEANUP_INTERVAL: string = '0 * * * *';

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------
export const DISCORD_BOT_TOKEN: string = process.env.DISCORD_BOT_TOKEN as string;
export const DISCORD_APP_ID: string = process.env.DISCORD_APP_ID as string;
export const DISCORD_PUBLIC_KEY: string = process.env.DISCORD_PUBLIC_KEY || '';
export const DISCORD_DEV_GUILD_ID: string | null = process.env.DISCORD_DEV_GUILD_ID || null;

// ---------------------------------------------------------------------------
// Groq (D11 provider swap — replaces Anthropic).
//
// The `src/lib/anthropic/` directory keeps its historical name so import paths
// across the codebase remain stable. The underlying provider is Groq via the
// OpenAI-compatible chat completions endpoint at `https://api.groq.com/openai/v1`.
//
// `AI_DAILY_TOKEN_BUDGET` is re-exported as `ANTHROPIC_DAILY_TOKEN_BUDGET` for
// backwards compat with the existing budget ledger (bucket keys still use the
// historical name; renaming the DB key would orphan today's ledger row).
// ---------------------------------------------------------------------------
export const GROQ_API_KEY: string = process.env.GROQ_API_KEY as string;
export const GROQ_MODEL: string = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
export const GROQ_BASE_URL: string = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
// D6 daily budget. Combined prompt + completion token ledger. Defaults sized
// for a hackathon demo: 200k prompt + 50k completion. Override via env for
// production. `AI_DAILY_TOKEN_BUDGET` is the new canonical name;
// `ANTHROPIC_DAILY_TOKEN_BUDGET` remains as a deprecated fallback.
export const AI_DAILY_TOKEN_BUDGET: number =
  Number(process.env.AI_DAILY_TOKEN_BUDGET) ||
  Number(process.env.ANTHROPIC_DAILY_TOKEN_BUDGET) ||
  250000;
// Legacy alias — do not use in new code. Kept so `budget.ts` and any other
// caller that grew up on the old name keeps compiling without churn.
export const ANTHROPIC_DAILY_TOKEN_BUDGET: number = AI_DAILY_TOKEN_BUDGET;

// ---------------------------------------------------------------------------
// Renaiss main API (api.renaiss.xyz/v0)
// ---------------------------------------------------------------------------
export const RENAISS_API_BASE: string = process.env.RENAISS_API_BASE || 'https://api.renaiss.xyz/v0';

// ---------------------------------------------------------------------------
// Renaiss Index API (api.renaissos.com/v1)
// ---------------------------------------------------------------------------
export const RENAISS_INDEX_BASE: string = process.env.RENAISS_INDEX_BASE || 'https://api.renaissos.com/v1';

/** Partner tier — apply at https://index.renaissos.com/api-docs (10k/day per key). */
export const RENAISS_INDEX_KEY_ID: string = process.env.RENAISS_INDEX_KEY_ID || '';
export const RENAISS_INDEX_SECRET: string = process.env.RENAISS_INDEX_SECRET || '';

// ---------------------------------------------------------------------------
// BSC
// ---------------------------------------------------------------------------
export const BSC_RPC_PRIMARY: string = process.env.BSC_RPC_PRIMARY || 'https://bsc.publicnode.com';
export const BSC_RPC_FALLBACK: string = process.env.BSC_RPC_FALLBACK || 'https://rpc.ankr.com/bsc';
export const BSC_CHAIN_ID: number = Number(process.env.BSC_CHAIN_ID) || 56;

// ---------------------------------------------------------------------------
// Indexer
// ---------------------------------------------------------------------------
export const INDEXER_POLL_INTERVAL_MS: number = Number(process.env.INDEXER_POLL_INTERVAL_MS) || 30000;

// Production pack slugs per architecture Section 8 and prisma/schema.prisma:53.
// Default kept aligned so a fresh checkout indexes real packs without env override.
const rawTrackedPacks: string = process.env.INDEXER_TRACKED_PACKS || 'eden-pack,omega,renacrypt-pack';
export const INDEXER_TRACKED_PACKS: string[] = rawTrackedPacks
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------
export const DISCORD_POST_RATE_PER_CHANNEL_PER_MIN: number =
  Number(process.env.DISCORD_POST_RATE_PER_CHANNEL_PER_MIN) || 10;
export const INDEX_API_DAILY_BUDGET: number = Number(process.env.INDEX_API_DAILY_BUDGET) || 800;

// ---------------------------------------------------------------------------
// Big Trade Alert worker
// ---------------------------------------------------------------------------
// Default channel threshold in USD cents. Only trades with priceUsdCents >=
// this value trigger a Discord alert. Per-channel overrides live in
// Subscription.metadata.threshold_usd_cents. 500000 cents = $5,000.
export const BIG_TRADE_USD_CENTS_DEFAULT: number =
  Number(process.env.BIG_TRADE_USD_CENTS_DEFAULT) || 500000;
// How many trades to pull each 5-min tick. Server default limit is small; 50
// gives us headroom for a busy 5-min window without blowing daily budget.
// Daily load: 50 items × 288 ticks/day = 14,400 items ingested, but only 1
// upstream request per tick = 288 requests/day. Well under the 1,000/day
// public-tier IP budget noted in 17_renaiss_cli_indexapi_research.md Section 4.
export const BIG_TRADE_POLL_LIMIT: number =
  Number(process.env.BIG_TRADE_POLL_LIMIT) || 50;
// Batch threshold: if more than this many trades qualify in one tick, we send a
// single digest embed instead of N individual alerts. Guards against a market
// move dumping dozens of alerts into a channel at once.
export const BIG_TRADE_BATCH_THRESHOLD: number =
  Number(process.env.BIG_TRADE_BATCH_THRESHOLD) || 20;
// Cursor sentinel packSlug so we can reuse the existing Cursor table without
// a schema change. Not user-facing; not indexed as a "real" pack.
export const BIG_TRADE_CURSOR_SLUG: string = '__big-trade-alert__' as const;

// ---------------------------------------------------------------------------
// Share card
// ---------------------------------------------------------------------------
export const SHARE_CARD_BASE_URL: string = process.env.SHARE_CARD_BASE_URL || 'http://localhost:3700/og';

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------
// Optional build marker injected by CI (`GIT_SHA=$(git rev-parse HEAD)`).
// Surfaces on /health so the ops dashboard can confirm the deployed commit.
export const GIT_SHA: string | null =
  typeof process.env.GIT_SHA === 'string' && process.env.GIT_SHA.length > 0
    ? process.env.GIT_SHA
    : null;

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------
export default {
  APP_PORT,
  NODE_ENV,
  IS_DEV,
  IS_PROD,
  DATABASE_URL,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  ERROR_LOG_MAX_RECORDS,
  ERROR_LOG_CLEANUP_INTERVAL,
  DISCORD_BOT_TOKEN,
  DISCORD_APP_ID,
  DISCORD_PUBLIC_KEY,
  DISCORD_DEV_GUILD_ID,
  GROQ_API_KEY,
  GROQ_MODEL,
  GROQ_BASE_URL,
  AI_DAILY_TOKEN_BUDGET,
  ANTHROPIC_DAILY_TOKEN_BUDGET,
  RENAISS_API_BASE,
  RENAISS_INDEX_BASE,
  BSC_RPC_PRIMARY,
  BSC_RPC_FALLBACK,
  BSC_CHAIN_ID,
  INDEXER_POLL_INTERVAL_MS,
  INDEXER_TRACKED_PACKS,
  DISCORD_POST_RATE_PER_CHANNEL_PER_MIN,
  INDEX_API_DAILY_BUDGET,
  BIG_TRADE_USD_CENTS_DEFAULT,
  BIG_TRADE_POLL_LIMIT,
  BIG_TRADE_BATCH_THRESHOLD,
  BIG_TRADE_CURSOR_SLUG,
  SHARE_CARD_BASE_URL,
};



<div align="center">

# PullCast Backend

**Fastify + Prisma + Discord + Renaiss on Bun.**

<br />

![Fastify](https://img.shields.io/badge/Fastify-5-000000?style=flat-square)
![Bun](https://img.shields.io/badge/Bun-1.x-FBF0DF?style=flat-square)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?style=flat-square)
![Postgres](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square)
![Discord.js](https://img.shields.io/badge/discord.js-14-5865F2?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

</div>

---

## What this is

The backend is one Bun process that runs four things at once:

1. **Fastify HTTP server** on `:3700` — 20+ REST endpoints for the web frontend and CLI
2. **Discord bot** via discord.js 14 — 19 slash commands registered on boot
3. **Cron workers** — indexer (1 min), BigTradeAlert (5 min), leaderboard (hourly), cardOfTheDay (daily)
4. **Renaiss integrations** — main API client, OS Index API client with circuit breaker and stale cache

Every response follows a canonical envelope shape with `sources` and `warnings` arrays. Every AI answer runs through a citation guard. Every price surface carries a beta disclaimer.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Bun | 1.0+ | Runtime |
| PostgreSQL | 16 | Pulls + subscriptions + snapshots |
| Discord bot | latest | Bot login + slash command registration |
| Renaiss OS Index partner keys | current | Partner tier upstream access |
| Groq API key | optional | Required for `/explain`, `/listing`, `/valuate photo` |

---

## Local dev

```bash
bun install
cp .env.example .env    # fill in the required vars below
bun run db:push         # push Prisma schema to Postgres
bun dev                 # http://localhost:3700
```

### Required env vars

```
# Database
DATABASE_URL=postgres://user:pass@localhost:5432/pullcast?schema=public

# Discord
DISCORD_BOT_TOKEN=<from https://discord.com/developers/applications>
DISCORD_APP_ID=<same source>
DISCORD_DEV_GUILD_ID=<your test server snowflake for instant slash registration>

# Renaiss OS Index (partner tier)
RENAISS_INDEX_KEY_ID=rk_...    # 27 chars
RENAISS_INDEX_SECRET=rsk_...   # 52 chars — count them!
RENAISS_INDEX_BASE=https://api.renaissos.com/v1

# Renaiss main API
RENAISS_API_BASE=https://api.renaiss.xyz/v0

# BSC RPC
BSC_RPC_PRIMARY=https://bsc.publicnode.com
BSC_RPC_FALLBACK=https://rpc.ankr.com/bsc

# Indexer packs (comma-separated)
INDEXER_TRACKED_PACKS=eden-pack,omega,renacrypt-pack

# AI (optional)
GROQ_API_KEY=<from https://console.groq.com/keys>
```

### At boot you should see

```
[boot] renaiss-index partner_auth=true headers_sent=[accept,user-agent,X-Api-Key,X-Api-Secret]
[boot] warmed indices OK
[boot] warmed indices/pokemon OK
[boot] warmed indices/one-piece OK
[boot] warmed featured?limit=24 OK
[boot] warmed trades/recent OK
[discord] logged in as PullCast#9831
[discord] registered 19 commands scope=guild=<YOUR_ID>
[indexer] scheduling tracked=eden-pack,omega,renacrypt-pack
[leaderboard] scheduled hourly=5 * * * * dailyPost=0 4 * * *
[CardOfTheDay] Scheduled schedule="0 0 * * *" tz=Asia/Hong_Kong
[BigTradeAlert] Scheduled schedule="*/5 * * * *" tz=Asia/Hong_Kong threshold_usd_cents=500000
Server started successfully on port 3700
```

All five `warmed` lines mean the Renaiss keys are valid and the cache is hot.

---

## Project layout

```
backend/
├── index.ts                     Entry point. Boots Fastify + Discord + 4 workers.
├── dotenv.ts                    Loads .env once at startup.
├── prisma/
│   └── schema.prisma            User, Pull, Subscription, LeaderboardSnapshot, ...
├── src/
│   ├── config/
│   │   └── main-config.ts       Env-var single source of truth.
│   ├── routes/                  20+ REST route handlers
│   │   ├── healthRoutes.ts
│   │   ├── pullRoutes.ts
│   │   ├── priceRoutes.ts
│   │   ├── marketRoutes.ts
│   │   ├── tradesRoutes.ts
│   │   ├── marketplaceRoutes.ts
│   │   ├── packsRoutes.ts
│   │   ├── cardSlugRoutes.ts
│   │   ├── leaderboardRoutes.ts
│   │   ├── oddsRoutes.ts
│   │   ├── aiRoutes.ts
│   │   ├── ogRoutes.ts
│   │   ├── statsRoutes.ts
│   │   ├── reportRoutes.ts
│   │   ├── profileRoutes.ts
│   │   ├── valuateRoutes.ts
│   │   └── renaissIdRoutes.ts
│   ├── workers/                 4 cron workers
│   │   ├── indexer.ts           BSC indexer + Renaiss main API polling
│   │   ├── bigTradeAlert.ts     Polls /v1/trades/recent every 5 min
│   │   ├── cardOfTheDay.ts      Top featured mover posted daily
│   │   ├── leaderboard.ts       Hourly Pull-of-the-Day snapshot
│   │   └── errorLogCleanup.ts
│   ├── lib/
│   │   ├── discord/             discord.js client + 19 slash commands
│   │   │   ├── client.ts
│   │   │   ├── command-registry.ts
│   │   │   ├── embed-builders.ts
│   │   │   ├── action-rows.ts
│   │   │   ├── share-card-poster.ts
│   │   │   └── commands/        19 command handlers
│   │   ├── renaiss/             Renaiss main API client
│   │   ├── renaiss-index/       OS Index API client + cache + circuit breaker
│   │   ├── ethers/              Read-only BSC provider + contract handles
│   │   ├── anthropic/           Groq LLM client + prompts + citation guard
│   │   ├── share-card/          Satori + resvg PNG renderer
│   │   ├── disclosure/          Beta disclosure single source
│   │   ├── odds/                Pull-economy stats
│   │   ├── db/                  pull-upsert with ON CONFLICT
│   │   ├── rate-limit.ts        Atomic Postgres token bucket
│   │   └── prisma.ts            Prisma client
│   ├── middlewares/
│   └── utils/
│       ├── errorHandler.ts      Canonical error envelope
│       ├── paramValidators.ts   Wallet, tokenId, cert, pullId, slug validators
│       ├── envelope.ts          buildEnvelope helper
│       └── redactSecrets.ts
├── cli/                         `pullcast` CLI verb tree
├── docs/                        API + slash command reference
├── tests/                       Vitest test suites
└── scripts/                     One-off maintenance scripts
```

---

## Data sources

| Source | Base URL | Wired at |
|--------|----------|----------|
| Renaiss main API | `https://api.renaiss.xyz/v0` | `src/lib/renaiss/` |
| Renaiss OS Index API | `https://api.renaissos.com/v1` | `src/lib/renaiss-index/` |
| BSC mainnet RPC | `https://bsc.publicnode.com` (fallback `https://rpc.ankr.com/bsc`) | `src/lib/ethers/` |

BSC contracts (read-only, source: `src/lib/ethers/contracts.ts`):

| Contract | Address |
|----------|---------|
| Registry V3 (ERC721 collectible) | `0xF8646A3Ca093e97Bb404c3b25e675C0394DD5b30` |
| TokenVendingMachine (pack purchase + mint) | `0x9215503e1e14ce0a16dad63d144687ba79485bd7` |
| Orderbook | `0xdb44a7c5598855b78e4f41552c11acc9d0a5892a` |

---

## Response envelope

Every REST route returns the same shape:

```json
{
  "success": true,
  "error": null,
  "data": { ... },
  "sources": [
    { "label": "Renaiss main API (beta)", "url": "..." }
  ],
  "warnings": [
    { "code": "BETA", "message": "Beta data..." }
  ],
  "generated_at": "2026-07-11T14:30:12.000Z"
}
```

On error:

```json
{
  "success": false,
  "error": { "code": "INDEX_API_RATE_LIMITED", "message": "..." },
  "data": null,
  "timestamp": "2026-07-11T14:30:12.000Z"
}
```

---

## Safety posture

Six layers, bypassing any one is a build-breaking bug.

1. **Mandatory disclosure** on every JSON envelope and every share card. `src/lib/disclosure/index.ts` is the single source.
2. **Citation guard** on every AI response. `src/lib/anthropic/citation-guard.ts` refuses to publish an answer without ≥ 2 cited sources and one citation per paragraph.
3. **Predictive-question refusal** pre-call. Regex catches `should I buy`, `moonshot`, etc. before spending tokens.
4. **Read-only on-chain.** `src/lib/ethers/provider.ts` only constructs a `JsonRpcProvider`. No signer, no `Wallet`, no private key loaded anywhere.
5. **Atomic rate limiting.** `src/lib/rate-limit.ts` issues one `Prisma.sql` upsert per call so concurrent consumers cannot both drain the last token.
6. **OptOut model** + soft delete everywhere. Wallet owners can globally suppress posts. Every model has `deletedAt`; every read query filters `deletedAt: null`.

---

## Smoke test

```bash
# Health
curl -s http://localhost:3700/health | jq

# Renaiss OS Index (partner tier)
curl -s 'http://localhost:3700/api/featured?limit=3' | jq '.success'
curl -s 'http://localhost:3700/api/trades/recent?limit=3' | jq '.success'
curl -s 'http://localhost:3700/api/market' | jq '.success'

# Renaiss main API
curl -s 'http://localhost:3700/api/marketplace?limit=3' | jq '.success'
curl -s 'http://localhost:3700/api/packs' | jq '.success'

# Cert Bridge (Main + Index)
curl -s 'http://localhost:3700/api/price/cert/PSA73628064' | jq '.data.confidence'

# Live leaderboard
curl -s 'http://localhost:3700/api/leaderboard/daily' | jq '.data.entries | length'

# Rate-limit demo (expect ~20 200s then 429s)
for i in $(seq 1 25); do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3700/api/price/cert/PSA73628064
done
```

---

## Deployment

One Bun process. Recommended: Railway or Fly.io backed by managed Postgres (Neon, Supabase, Vercel Postgres).

Constraints:

- `bun run db:push` must run once before first boot to generate the Prisma client at `prisma/generated/`.
- node-cron schedules run in-process; no external cron service required.
- Discord global slash commands take up to an hour to propagate. During dev, set `DISCORD_DEV_GUILD_ID` so commands register as guild commands (instant).
- Renaiss OS Index partner keys must be exact-length: key 27 chars, secret 52 chars.

---

## License

MIT.

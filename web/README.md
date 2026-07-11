<div align="center">

# PullCast Web

**Public gallery + Card Lens + Live trades for Renaiss collectors.**

<br />

![TanStack](https://img.shields.io/badge/TanStack-Start-FF4154?style=flat-square)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square)
![Tailwind](https://img.shields.io/badge/Tailwind-4-06B6D4?style=flat-square)
![Vite](https://img.shields.io/badge/Vite-7-646CFF?style=flat-square)
![HeroUI](https://img.shields.io/badge/HeroUI-latest-000000?style=flat-square)
![GSAP](https://img.shields.io/badge/GSAP-3-88CE02?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

</div>

---

## What this is

The PullCast web app is the shareable surface for every Renaiss pull. 12 SSR-rendered routes wired to the PullCast backend at `http://localhost:3700`. Rendered with TanStack Start (React 19 meta-framework) + HeroUI + Tailwind 4 + GSAP + Lenis smooth scroll + Framer Motion.

Every route hits the same envelope-shaped backend API and shows real data — live BSC-indexed pulls, live Renaiss OS Index tiles, live graded trade feed, live Pull-of-the-Day leaderboard.

---

## Routes

```
/                          landing — hero fan + Pull of the Day + Recent pulls + Ecosystem section
/market                    Renaiss OS Index tiles with "What is an Index?" explainer
/trades                    live cross-market graded trade feed
/featured                  top-mover cards with per-grade FMV
/browse                    marketplace search with grader + category filters
/price                     Card Lens (cert or tokenId lookup)
/search                    free-text card search
/packs                     tracked pack list + detail
/stats                     adoption counters + activity timeline + leaderboard
/ecosystem                 integration matrix (Main / Index / CLI parity)
/$address                  public wallet gallery with infinite scroll
/card/$game/$set/$card     card detail with reference price + sparkline + trades
/card/$tx                  card detail by pull id (short link)
/sets/$game/$set           set listing with aggregate FMV
```

---

## Tech stack

| Layer | Tech | Version |
|-------|------|---------|
| Framework | TanStack Start | latest |
| UI runtime | React | 19 |
| Router | TanStack Router | file-based |
| Data | TanStack Query | 5 |
| Styling | Tailwind CSS | 4 |
| Components | HeroUI | latest |
| Animation (macro) | GSAP + ScrollTrigger | 3 |
| Animation (interaction) | motion / react (Framer Motion) | latest |
| Smooth scroll | Lenis | latest |
| Build | Vite + Nitro | 7 |
| Runtime / dev | Bun | 1.x |
| Type check | TypeScript | strict |

---

## Local dev

```bash
bun install
bun dev              # http://localhost:3200
```

The dev server proxies `/api/*` and `/health` to `http://localhost:3700` via the `VITE_API_URL` env var. If your backend runs elsewhere, set:

```bash
VITE_API_URL=https://your-backend.example.com bun dev
```

### Build

```bash
bun run build        # SSR output to .output/
bun run preview      # serve production build locally
```

### Lint + format

```bash
bun lint
bun format
bun check            # format + lint fix
```

---

## Project layout

```
web/
├── src/
│   ├── routes/                    12 file-based routes (TanStack Router)
│   │   ├── __root.tsx             root layout — Providers, PillNavbar, Footer
│   │   ├── index.tsx              landing page
│   │   ├── market.tsx             Renaiss OS Index tiles
│   │   ├── trades.tsx             live trade feed
│   │   ├── featured.tsx           top movers
│   │   ├── browse.tsx             marketplace search
│   │   ├── price.tsx              Card Lens
│   │   ├── search.tsx             free-text search
│   │   ├── packs.tsx              pack list
│   │   ├── stats.tsx              adoption + leaderboard
│   │   ├── ecosystem.tsx          integration matrix
│   │   ├── $address.tsx           wallet gallery
│   │   ├── card.$game.$set.$card.tsx    card detail (slug)
│   │   ├── card.$tx.tsx           card detail (pull id)
│   │   └── sets.$game.$set.tsx    set listing
│   ├── components/                shared UI
│   │   ├── nav/PillNavbar.tsx     top nav with dropdowns
│   │   ├── layout/Footer.tsx      Pivy-style rounded-top footer
│   │   ├── share-card/            share-card component + tier gradients
│   │   ├── charts/                Sparkline
│   │   ├── ui/                    Chip, Skeleton, GradeBadge, etc.
│   │   └── index/                 IndexAttribution
│   ├── lib/
│   │   ├── api/client.ts          envelope-aware fetch wrapper + all endpoint helpers
│   │   ├── motion/                GSAP + Lenis + reduced-motion providers
│   │   └── index-href.ts          slug parsing + strip helpers
│   ├── utils/
│   │   ├── style.ts               cnm() className merge
│   │   ├── format.ts              currency / number formatting
│   │   └── upstreamError.ts       friendly rate-limit message helper
│   ├── integrations/tanstack-query/    Query provider setup
│   ├── providers/                 HeroUI + Lenis smooth scroll
│   ├── hooks/                     custom React hooks
│   ├── styles.css                 Tailwind 4 @theme + global styles
│   ├── config.ts                  app-wide config (links, feature flags)
│   ├── env.ts                     T3Env type-safe env
│   ├── router.tsx                 router setup
│   └── routeTree.gen.ts           auto-generated route tree
├── public/
│   └── assets/                    logo + favicon
├── vite.config.ts                 Vite + TanStack Start config
├── tsconfig.json                  strict TypeScript
├── eslint.config.js               ESLint config
├── prettier.config.js             Prettier config
└── vercel.json                    Vercel deployment config
```

---

## Key features

### Hero fan animation
The landing page hero shows a fan of 3 share cards (rotated -6°, 0°, +6°). Hovering anywhere on the fan spreads the cards apart with 3D depth using `rotateY` and `translate3d` — like a dealer opening a hand of cards. Powered by React state + CSS transitions with `cubic-bezier(0.22, 1, 0.36, 1)` easing at 550ms.

### Pull of the Day section
Between the hero and Recent pulls, the top 3 net-gain pulls from the last 24 hours render as medaled cards (🥇🥈🥉). Each card has a tier-based gradient hero art (gold for legendary, purple for epic, blue for uncommon, gray for common), FMV + net gain columns, and a truncated tokenId + wallet footer. Section auto-hides on empty state.

### Market page with explainer
`/market` renders the Renaiss OS Index tiles (Pokémon + One Piece + Sports) with sparklines. A collapsible "What is a Renaiss OS Index?" panel explains what the index means for laypeople — basket of top 50 most-traded cards per game, rebalanced monthly, base 10,000 at launch.

### Card detail with waterfall load
`/card/{game}/{set}/{card}` fires 4 backend requests in a serialized waterfall (main → overview → fmv → trades) so we never exceed Renaiss's per-second burst limit. Each satellite request waits for the previous one to complete (success or fail) before firing. Adds ~200ms to full load but every fetch succeeds cleanly.

### Wallet gallery with OG images
`/{wallet_address}` renders an infinite-scroll gallery of every pull for a Renaiss wallet. Uses `useInfiniteQuery` with cursor keyset pagination. SSR renders proper OG meta tags with `/og/wallet/{address}` (1200×630 PNG) for shareable link previews on Discord, X, and Slack.

### Live trade feed
`/trades` shows the last N cross-market graded trades from Renaiss OS Index with card thumbnails, prices, and source labels. Refetches every 3 minutes (was 60s — we reduced polling to respect Renaiss quota).

### Graceful rate-limit UI
When Renaiss upstream returns 429, the backend maps it to a specific `INDEX_API_RATE_LIMITED` error code. The frontend `friendlyUpstreamMessage()` helper detects this code and renders a warning-tone "Live data paused" panel instead of a generic red error.

### Grouped navigation dropdowns
Top nav is a pill navbar with grouped dropdown menus:
- **Discover** — Market, Trades, Featured, Browse
- **Lookup** — Card Lens, Search
- **Data** — Stats, Ecosystem
- **Home**, **Packs** as direct links
- **Install Bot** as the primary CTA

---

## Deployment

The web app is designed for Vercel. `vercel.json` is already configured — just push to the linked repo and Vercel handles the rest.

Required env vars in production:

```
VITE_API_URL=https://api.pullcast.xyz    # your deployed backend URL
VITE_APP_TITLE=PullCast
```

---

## License

MIT.

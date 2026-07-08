# pullcast

Community CLI that **extends the official Renaiss CLI (`npx renaiss`)** with a
collector-focused layer over the Renaiss main API and the Renaiss OS Index API.

> Early preview. Read-only commands only. Data is experimental beta from
> Renaiss APIs. Not financial advice.

## Install

Run without installing:

```sh
npx pullcast --help
```

Or install globally:

```sh
npm install -g pullcast
pullcast --help
```

Requires Node.js 22 or newer.

## Usage

```sh
pullcast pull 0x602119ef58d2aa963256b105948899ea0a890903 --limit 10
pullcast price 15673003569618327101057043351765386873514582732304171200934046913443592715494
pullcast valuate PSA73628064
pullcast market --game pokemon
pullcast featured --limit 5
pullcast marketplace --grading PSA --limit 5
pullcast card 110407444306463577498147203724752028878073766094690908117614973479773124263178 --price
pullcast gacha list
pullcast gacha list eden-pack --json
pullcast gacha info eden-pack --json
```

Every verb supports `--json` and returns the standard envelope:

```json
{
  "data": { ... },
  "sources": [{ "label": "Renaiss OS Index (beta)", "url": "..." }],
  "warnings": [{ "code": "BETA", "message": "..." }],
  "generated_at": "..."
}
```

## Configuration

Override the default upstream base URLs via env vars:

```sh
export PULLCAST_API_URL=https://api.pullcast.xyz        # PullCast backend
export RENAISS_API_URL=https://api.renaiss.xyz          # Renaiss main API
export RENAISS_INDEX_URL=https://api.renaissos.com      # Renaiss OS Index
```

## Publishing

The package name `pullcast` is claimed on npm. Publishing is a manual step:

```sh
cd backend/cli
bun run build:mjs
npm publish
```

## Relation to `npx renaiss`

The official Renaiss CLI (`npx renaiss@0.0.3-beta.2`) exposes browse verbs
(`marketplace`, `card`) and a `gacha` command group (`gacha list | pull |
buyback`) over the Renaiss main API. `pullcast` mirrors the READ verbs 1:1
(same flag names, same shape) and adds a collector layer on top.

### Verbs that mirror `npx renaiss` exactly

- `pullcast marketplace` — matches `npx renaiss marketplace` exactly
- `pullcast card <tokenId>` — matches `npx renaiss card` exactly
- `pullcast gacha list [slug] [--include-inactive]` — matches
  `npx renaiss gacha list` exactly

### PullCast read-only companion (no upstream equivalent)

- `pullcast gacha info <packSlug>` — pack detail + dual-window empirical odds
  blend. Combines `/api/packs/:slug` metadata with the D8 `/api/odds/:slug`
  dual-window (upstream-recent + trailing-90d) surface.

### Write verbs NOT mirrored (intentional)

The upstream `gacha pull` and `gacha buyback` verbs require a Safe owner
private key and move real USDT. PullCast is read-only and does not expose
these. Users who want to pull or buy back should invoke the official CLI:
`npx renaiss@0.0.3-beta.2 gacha pull <packSlug>` /
`npx renaiss@0.0.3-beta.2 gacha buyback <packSlug> <checkoutIds...>`.

### Deprecated aliases

- `pullcast packs [slug]` — alias for `pullcast gacha list [slug]`. Emits a
  deprecation warning to stderr. Removed in v0.1.0.

### PullCast collector-layer additions

- `pull <address>` — pulls by wallet, sourced from the PullCast indexer
- `price <id-or-cert>` — cross-source blend using both Renaiss APIs
- `valuate <cert>` — cert valuation with formatted output
- `market [--game]` — Renaiss OS Index basket tiles
- `featured [--limit]` — Renaiss OS Index top movers

Use both side by side.

## `pullcast marketplace`

Mirrors `npx renaiss marketplace` exactly. Every flag on the official CLI has
an equivalent flag here, and CLI flag names map onto backend query params so
you can pass the same values you'd pass to `renaiss marketplace`.

```
--search <term>      Search collectibles (min 3 chars)
--category <name>    POKEMON | ONE_PIECE
--listed             Show only listed collectibles
--language <lang>    Filter by language
--grading <company>  PSA | BGS | CGC | SGC
--grade <value>      e.g. "10 Gem Mint"
--year <range>       e.g. "2020-2025"
--price <range>      e.g. "100-1000"
--sort <field>       fmvPriceInUsd | year | grade | name | listDate | mintDate
--order <dir>        asc | desc (default: desc)
--limit <n>          1-100 (default: 10)
--offset <n>         Pagination offset (default: 0)
--json               Output raw JSON envelope
```

Under the hood, `pullcast marketplace` delegates to the PullCast backend
`GET /api/marketplace` route (which fronts Renaiss `/v0/marketplace` with
in-process caching, per-IP rate limiting and boundary input validation).

Example:

```sh
pullcast marketplace --grading PSA --category POKEMON --limit 3 --json
```

```json
{
  "data": {
    "collection": [
      {
        "tokenId": "1104074443064635774981472037247520288...",
        "name": "PSA 10 Gem Mint 2022 Pokemon Sword & Shield Astral Radiance #TG13 Starmie V",
        "setName": "Pokemon Sword & Shield Astral Radiance",
        "grade": "10 Gem Mint",
        "gradingCompany": "PSA",
        "fmvPriceInUSD": "33495",
        "askPriceInUSDT": "408000000000000000000",
        "year": 2022
      }
    ],
    "pagination": { "total": 802, "limit": 3, "offset": 0, "hasMore": true }
  },
  "sources": [
    { "label": "PullCast API", "url": "https://api.pullcast.xyz/api/marketplace" },
    { "label": "Renaiss API (beta)", "url": "https://api.renaiss.xyz/v0/marketplace" }
  ],
  "warnings": [{ "code": "BETA", "message": "..." }],
  "generated_at": "2026-07-03T..."
}
```

## `pullcast card`

Mirrors `npx renaiss card <tokenId>` exactly.

```
--price       Show price information (default: on)
--activities  Show activity history
--verbose     Show extended price details with --price
--json        Output raw JSON envelope
```

Unlike the official verb, `pullcast card` delegates to the PullCast backend
`GET /api/price/token/:tokenId` route which blends three sources:

- Renaiss main API `/v0/collectibles/{tokenId}` — card metadata + FMV
- Renaiss OS Index API `/v1/graded/{cert}` — index FMV + confidence
- Orderbook `TradeExecutedV2` event log on BSC — last on-chain sale price + tx

The `--verbose` flag adds source URLs inline so you can trace every price
back to its origin.

Example:

```sh
pullcast card 110407444306463577498147203724752028878073766094690908117614973479773124263178 --price --json
```

```json
{
  "data": {
    "tokenId": "1104074443...",
    "cardName": "PSA 10 Gem Mint 2022 Pokemon ... Starmie V",
    "setName": "Pokemon Sword & Shield Astral Radiance",
    "gradingCompany": "PSA",
    "grade": "10 Gem Mint",
    "serial": "PSA114458483",
    "price": {
      "mainApiFmvUsdCents": 33495,
      "indexApiFmvUsdCents": 34200,
      "recommendedFmvUsdCents": 34200,
      "confidence": "high",
      "lastSaleAt": "2026-06-30T14:22:11.000Z",
      "variancePctOver20": false,
      "onChainLastSale": {
        "priceUsdcFormatted": "408.00",
        "txHash": "0x1234...",
        "bscscanUrl": "https://bscscan.com/tx/0x1234..."
      }
    }
  }
}
```

## License

MIT

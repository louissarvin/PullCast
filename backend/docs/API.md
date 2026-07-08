# PullCast REST API Reference

Reference for the public HTTP surface served by Fastify on port `APP_PORT` (default `3700`). All routes follow the conventions below; per-endpoint detail starts at [Health](#health).

## Conventions

### Response envelope

Every JSON response uses the project-wide envelope from `src/utils/errorHandler.ts`:

```jsonc
// Success
{
  "success": true,
  "error": null,
  "data": { /* endpoint payload */ }
}

// Error
{
  "success": false,
  "error": { "code": "INVALID_PARAM", "message": "Invalid pullId" },
  "data": null,
  "timestamp": "2026-06-30T12:34:56.789Z"
}
```

### `_disclosure` field

Every successful `data` payload is wrapped through `attachDisclosure()` (`src/lib/disclosure/index.ts`). The wrapper adds a top-level `_disclosure` string:

```
"_disclosure": "Beta data from Renaiss API and Renaiss Index API (experimental). Sources cited. Not financial advice."
```

This is intentional. The `_disclosure` key survives `JSON.stringify`, so a downstream client cannot accidentally strip the beta warning during normalization. Refusal responses keep the field. The OG endpoint returns binary `image/png` and carries the disclosure inside the rendered watermark instead.

### Rate limiting

Per-IP rate limits use the atomic Postgres token-bucket (`src/lib/rate-limit.ts`). Exceeding a bucket returns HTTP 429 with body `{ "error": { "code": "RATE_LIMITED", "message": "Too many requests" } }`. Buckets refill linearly each minute; there is no `Retry-After` header.

### Pagination

Pull list endpoints use keyset pagination ordered by `(pulledAtTimestamp DESC, id DESC)`. The client passes back the `nextCursor` value from the previous response as `?cursor=<id>`. Cursors that resolve to an unknown / soft-deleted id are treated as "start from the beginning."

### Validators

Path / query parameters are validated by `src/utils/paramValidators.ts`:

| Parameter | Regex | Notes |
|-----------|-------|-------|
| `tokenId` | `^[0-9]{1,78}$` | Decimal string, uint256-safe |
| `cert` | `^(PSA\|BGS\|CGC\|SGC)\d{6,12}$` | Case-insensitive on input; uppercased before use |
| `wallet` | `^0x[a-fA-F0-9]{40}$` | Lowercased before use |
| `pullId` / `cursor` | `^[a-z0-9]{24,30}$/i` | cuid v1 or v2 |
| `limit` | integer | Per-endpoint range; default specified per route |
| `pack` | `^[a-z0-9][a-z0-9-]{0,63}$` AND member of `INDEXER_TRACKED_PACKS` | |

Validation failures return HTTP 400 with `error.code: 'INVALID_PARAM'`.

---

## Health

### `GET /health`

Liveness + ops dashboard payload. No auth, no DB hit beyond the indexer cursor read.

Response `data`:

```jsonc
{
  "status": "ok",
  "uptimeSec": 1234,
  "indexerLastSuccessAt": "2026-06-30T12:30:00.000Z",  // null until first successful poll
  "discordReady": true,
  "gitSha": "abc1234"   // present only if process.env.GIT_SHA was set at boot
}
```

Rate limit: none. Example:

```bash
curl -s http://localhost:3700/health | jq
```

### `GET /health/db`

Postgres ping. Returns 200 either way; the client branches on `data.db`.

```jsonc
{ "db": "ok" }   // or "fail"
```

Rate limit: none.

---

## Pulls

`PullPublicProjection` (the shape returned for every Pull-bearing response, from `src/utils/paramValidators.ts`):

```ts
interface PullPublicProjection {
  id: string;
  packSlug: string;
  collectibleTokenId: string;       // uint256 as decimal string
  buyerAddress: string;             // 0x lowercased
  tier: string | null;
  fmvUsdCents: number | null;
  packPriceUsdCents: number;
  netGainUsdCents: number | null;
  pulledAtTimestamp: string;        // ISO 8601 (Date serialized)
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  gradingCompany: string | null;    // PSA | BGS | CGC | SGC
  grade: string | null;
  serial: string | null;            // cert, e.g. PSA73628064
  frontImageUrl: string | null;
  shareCardPostedAt: string | null;
  createdAt: string;
}
```

Fields intentionally excluded from public responses: `rawAttributesJson`, `txHash`, `blockNumber`, `backImageUrl`, `updatedAt`, `deletedAt`.

### `GET /api/pulls`

Global feed, newest first.

| Query | Type | Default | Range |
|-------|------|---------|-------|
| `limit` | integer | 50 | 1-200 |
| `cursor` | cuid | null | last item's `id` from previous page |

Response `data`:

```jsonc
{
  "pulls": [ /* PullPublicProjection[] */ ],
  "nextCursor": "clbxxx..." ,        // null when no more pages
  "_disclosure": "Beta data ..."
}
```

Errors: 400 `INVALID_PARAM` (bad limit / cursor), 500 `PULLS_LIST_FAILED`.

Rate limit: none.

```bash
curl -s 'http://localhost:3700/api/pulls?limit=5' | jq
```

### `GET /api/pulls/:id`

Single Pull lookup.

Response `data`:

```jsonc
{
  "pull": { /* PullPublicProjection */ },
  "_disclosure": "Beta data ..."
}
```

Errors: 400 `INVALID_PARAM` (malformed pullId), 404 (`handleNotFoundError`), 500 `PULL_GET_FAILED`.

### `GET /api/wallets/:address/pulls`

Per-wallet gallery. Address lowercased before query.

| Query | Type | Default | Range |
|-------|------|---------|-------|
| `limit` | integer | 50 | 1-200 |
| `cursor` | cuid | null | |

Errors: 400 `INVALID_PARAM` (bad wallet / limit / cursor), 500 `WALLET_PULLS_FAILED`.

---

## Price

All `/api/price/*` endpoints share an atomic per-IP token bucket: `http:ip:<ip>:price`, capacity 20, refill 20 / minute. The Renaiss Index API has a 60/min public-tier IP cap, and the bucket is sized to protect upstream first, our compute second.

### `GET /api/price/token/:id`

Blend the Renaiss main API FMV with the Renaiss Index API graded slab valuation. The route:

1. Calls `renaissApi.getCard(tokenId)`.
2. Normalizes the response, extracting `serial`, `gradingCompany`, `grade` from `attributes[]`.
3. If a `serial` is present, calls `getOrFetchCert(serial)` (cache-backed Index API lookup).
4. Picks `recommendedFmvUsdCents = indexCents ?? mainCents`.
5. Flags `variancePctOver20: true` when both signals are present and disagree by > 20%.

Response `data`:

```jsonc
{
  "tokenId": "123456",
  "cert": "PSA73628064",            // null when no serial linked
  "cardName": "...",
  "setName": "...",
  "cardNumber": "...",
  "gradingCompany": "PSA",
  "grade": "10 Gem Mint",
  "serial": "PSA73628064",
  "imageUrl": "https://...",
  "mainApiFmvUsdCents": 189000,
  "indexApiFmvUsdCents": 210000,
  "recommendedFmvUsdCents": 210000,
  "confidence": "high",             // 'high' | 'medium' | 'low' | null
  "lastSaleAt": "2026-06-15T...",
  "variancePctOver20": false,
  "hasGradedCert": true,
  "sources": [
    { "name": "Renaiss main API",  "url": "https://api.renaiss.xyz/v0/collectibles/123456" },
    { "name": "Renaiss Index API", "url": "https://api.renaissos.com/v1/graded/PSA73628064" }
  ],
  "_disclosure": "Beta data ..."
}
```

Errors:
- 400 `INVALID_PARAM` (malformed tokenId)
- 404 `TOKEN_NOT_FOUND` (main API 4xx)
- 429 `RATE_LIMITED`
- 502 `UPSTREAM_UNAVAILABLE` (main API 5xx or network)

```bash
curl -s http://localhost:3700/api/price/token/123456 | jq
```

### `GET /api/price/cert/:cert`

Direct Index API cert lookup via the read-through CertCache (1h TTL).

Response `data` when found:

```jsonc
{
  "cert": "PSA73628064",
  "found": true,
  "cardName": "...",
  "setName": "...",
  "cardNumber": "...",
  "gradingCompany": "PSA",
  "grade": "10 Gem Mint",
  "imageUrl": "...",
  "indexApiFmvUsdCents": 210000,
  "recommendedFmvUsdCents": 210000,
  "confidence": "high",
  "lastSaleAt": "2026-06-15T...",
  "certImages": { "front": "...", "back": "...", "item": "..." },
  "sources": [{ "name": "Renaiss Index API", "url": "https://api.renaissos.com/v1/graded/PSA73628064" }],
  "_disclosure": "Beta data ..."
}
```

When the upstream returns `found: false`, the route responds HTTP 404 with:

```jsonc
{
  "success": false,
  "error": { "code": "CERT_NOT_FOUND", "message": "No grading record for PSA73628064." },
  "data": {
    "cert": "PSA73628064",
    "found": false,
    "reason": "not_ingested",   // or company_unsupported | compute_incomplete | no_grade_price | game_unsupported | needs_photo
    "_disclosure": "Beta data ..."
  },
  "timestamp": "..."
}
```

Errors: 400 `INVALID_PARAM`, 429 `RATE_LIMITED`, 502 `UPSTREAM_UNAVAILABLE`.

### `GET /api/price/search`

Index API card search.

| Query | Type | Default | Range |
|-------|------|---------|-------|
| `q` | string | required | 1-200 chars |
| `limit` | integer | 10 | 1-25 |

Response `data`:

```jsonc
{
  "query": "charizard",
  "limit": 10,
  "results": [ /* IndexSearchResult[] from the Renaiss Index API, schema in src/lib/renaiss-index/schemas.ts */ ],
  "_disclosure": "Beta data ..."
}
```

Errors: 400 `INVALID_PARAM`, 429 `RATE_LIMITED`, 502 `UPSTREAM_UNAVAILABLE`.

---

## Leaderboard

Per-IP bucket `http:ip:<ip>:leaderboard`, capacity 30, refill 30 / minute.

### `GET /api/leaderboard/daily`

The latest `windowEndAt` from `LeaderboardSnapshot`, with its top 5 rows joined to `Pull`. When no snapshot has been written yet, the route synthesizes a trailing-24h labeling window and returns `entries: []` so the client can render an honest empty state.

Response `data`:

```jsonc
{
  "windowStartAt": "2026-06-29T12:00:00.000Z",
  "windowEndAt":   "2026-06-30T12:00:00.000Z",
  "computedAt":    "2026-06-30T12:00:00.000Z",
  "entries": [
    {
      "rank": 1,
      "pull": { /* PullPublicProjection */ },
      "netGainUsdCents": 12490100,
      "fmvUsdCents": 12500000
    }
    // ...
  ],
  "_disclosure": "Beta data ..."
}
```

Errors: 429 `RATE_LIMITED`, 500 `LEADERBOARD_FAILED`.

### `GET /api/leaderboard/history`

One row per past hourly window, top-1 (rank=1) only.

| Query | Type | Default | Range |
|-------|------|---------|-------|
| `limit` | integer | 24 | 1-168 (one week of hourly snapshots) |

Response `data`:

```jsonc
{
  "limit": 24,
  "items": [
    {
      "windowEndAt": "2026-06-30T12:00:00.000Z",
      "computedAt":  "2026-06-30T12:00:00.000Z",
      "top1": { "pull": { /* projection */ }, "netGainUsdCents": 12490100 }
    }
  ],
  "_disclosure": "Beta data ..."
}
```

Errors: 400 `INVALID_PARAM`, 429 `RATE_LIMITED`, 500 `LEADERBOARD_HISTORY_FAILED`.

---

## Odds

### `GET /api/odds/:pack`

Trailing 90-day pull-economy stats for a tracked pack. Per-IP bucket `http:ip:<ip>:odds`, 20 / min.

The `pack` path parameter must match the regex above AND appear in `INDEXER_TRACKED_PACKS`. Off-list packs return HTTP 404 with `error.code: 'PACK_NOT_TRACKED'` and a list of tracked packs in the message.

When the sample size is below `ODDS_MIN_SAMPLE` (10), the route returns HTTP 200 with `insufficientSample: true` and the aggregates zeroed (`top5: []`, `byTier: {}`, mean / median / win rate all 0). This is intentional: a structured response with an honest flag is safer than an error envelope a client might silently swallow.

Response `data`:

```jsonc
{
  "packSlug": "eden-pack",
  "windowDays": 90,
  "windowStartAt": "2026-04-01T12:00:00.000Z",
  "windowEndAt":   "2026-06-30T12:00:00.000Z",
  "totalPulls": 124,
  "insufficientSample": false,
  "minSample": 10,
  "meanNetGainUsdCents":   24500,
  "medianNetGainUsdCents": 12300,
  "winRate": 0.412,                // share of pulls with netGain > 0
  "top5": [
    { "netGainUsdCents": 1240000, "grade": "10", "gradingCompany": "PSA" }
  ],
  "byTier": {
    "legendary": { "count": 4,  "avgNetGain": 850000 },
    "rare":      { "count": 51, "avgNetGain":  18500 }
  },
  "_disclosure": "Beta data ..."
}
```

Errors: 400 `INVALID_PARAM`, 404 `PACK_NOT_TRACKED`, 429 `RATE_LIMITED`, 500 `ODDS_FAILED`.

---

## AI

Per-IP bucket `http:ip:<ip>:ai`, capacity 10, refill 10 / minute. Both endpoints are POST and require JSON bodies. Even when the AI refuses, the response is HTTP 200 with the refusal text in `data.text` and the reason in `data.refused.reason`, so consumers can render uniformly.

### `POST /api/explain`

Body:

```jsonc
{
  "subject": "cert" | "token",
  "value":   "PSA73628064" | "123456",   // validated by validateCert / validateTokenId
  "question": "5-800 chars"
}
```

Pipeline (in `src/lib/anthropic/explain.ts`):
1. Predictive-question regex (`should I buy`, `moonshot`, etc.) -> immediate refuse, no upstream calls.
2. `gatherSourcesForCert` / `gatherSourcesForTokenId` retrieves sources.
3. Refuse when `sources.length < 2`.
4. Token budget check (`assertTokenBudget`).
5. Claude Haiku call.
6. `stripUnreferencedCitations` removes hallucinated source IDs.
7. `enforceCitations` refuses unless every non-empty paragraph carries a `[source-N]` marker AND at least two distinct citations are present.
8. `appendDisclosureFooter`.

Response `data`:

```jsonc
{
  "text": "Two paragraphs ... [source-1] ... [source-2] ...",
  "sources": [
    { "id": 1, "name": "Renaiss Index API: PSA73628064", "url": "https://api.renaissos.com/v1/graded/PSA73628064" }
  ],
  "refused": null,                  // or { "reason": "predictive-question" | "insufficient-sources" | "uncited-claim" | "empty-response" | "budget-exhausted" }
  "_disclosure": "Beta data ..."
}
```

Errors: 400 `INVALID_PARAM`, 429 `RATE_LIMITED`, 500 `AI_ERROR`.

```bash
curl -s -X POST http://localhost:3700/api/explain \
  -H 'content-type: application/json' \
  -d '{"subject":"cert","value":"PSA73628064","question":"What is this card?"}' | jq
```

### `POST /api/listing`

Body:

```jsonc
{
  "subject": "cert" | "token",
  "value":   "PSA73628064" | "123456"
}
```

Numbers in the response are deterministic. `computeRange` (`src/lib/anthropic/listing.ts`) is pure arithmetic over real Index API trades and main API FMV; the AI receives the range as INPUT and writes only the explanation. Refusal cases match `/explain` (insufficient sources, uncited claim, budget exhausted).

Response `data`:

```jsonc
{
  "text": "Explanation referencing [source-1] [source-2] ...",
  "sources": [ { "id": 1, "name": "...", "url": "..." } ],
  "card": { /* normalized card metadata */ },
  "rangeLowUsdCents":  1800000,
  "rangeMidUsdCents":  2100000,
  "rangeHighUsdCents": 2450000,
  "comparableCount": 7,
  "primaryFmvUsdCents": 2100000,
  "primarySource": "renaiss-index" | "renaiss-main",
  "confidence": "high" | "medium" | "low" | null,
  "refused": null,
  "_disclosure": "Beta data ..."
}
```

Errors: 400 `INVALID_PARAM`, 429 `RATE_LIMITED`, 500 `AI_ERROR`.

---

## OG (share card preview)

### `GET /og/:pullId`

Returns the 1200x630 PNG share card for a Pull. Suitable for `og:image` and Twitter `summary_large_image`. Mounted at the root so social platforms get clean URLs (`https://pullcast.xyz/og/<id>`).

| Query | Type | Default | Notes |
|-------|------|---------|-------|
| `variant` | enum | auto-detect from `gradingCompany` | `psa \| bgs \| cgc \| sgc \| generic`. `sgc` is aliased to `generic` since the renderer has no SGC template. |

Response:
- Status 200, `Content-Type: image/png`, `Cache-Control: public, max-age=3600, immutable`.
- 400 with envelope when `pullId` is malformed.
- 404 with envelope when the Pull does not exist or is soft-deleted.
- On render failure the route falls back to a pre-warmed placeholder card (and only as a last resort a 1x1 transparent PNG), still 200. This is intentional so link previews never break.

Stampede protection: the underlying `getOrRenderShareCard` (`src/lib/discord/share-card-poster.ts`) keeps an in-memory `Map<key, Promise<RenderResult>>`. 50 concurrent previews trigger ONE render.

```bash
curl -s http://localhost:3700/og/<pullId> -o /tmp/card.png && file /tmp/card.png
curl -I http://localhost:3700/og/<pullId>
```

---

## Inline OpenAPI snippet (excerpt)

```yaml
openapi: 3.1.0
info: { title: PullCast API, version: 1.0.0 }
components:
  schemas:
    PullPublicProjection:
      type: object
      required: [id, packSlug, collectibleTokenId, buyerAddress, packPriceUsdCents, pulledAtTimestamp, createdAt]
      properties:
        id:                  { type: string }
        packSlug:            { type: string }
        collectibleTokenId:  { type: string }
        buyerAddress:        { type: string, pattern: '^0x[a-f0-9]{40}$' }
        tier:                { type: [string, 'null'] }
        fmvUsdCents:         { type: [integer, 'null'] }
        packPriceUsdCents:   { type: integer }
        netGainUsdCents:     { type: [integer, 'null'] }
        pulledAtTimestamp:   { type: string, format: date-time }
        cardName:            { type: [string, 'null'] }
        setName:             { type: [string, 'null'] }
        cardNumber:          { type: [string, 'null'] }
        gradingCompany:      { type: [string, 'null'], enum: [PSA, BGS, CGC, SGC, null] }
        grade:               { type: [string, 'null'] }
        serial:              { type: [string, 'null'] }
        frontImageUrl:       { type: [string, 'null'] }
        shareCardPostedAt:   { type: [string, 'null'], format: date-time }
        createdAt:           { type: string, format: date-time }
    Envelope:
      type: object
      properties:
        success: { type: boolean }
        error:   { oneOf: [{ type: 'null' }, { type: object, required: [code, message], properties: { code: { type: string }, message: { type: string } } }] }
        data:    { type: object }
paths:
  /health:
    get:
      summary: Liveness + ops payload
      responses:
        '200': { description: ok }
  /api/pulls:
    get:
      parameters:
        - in: query
          name: limit
          schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
        - in: query
          name: cursor
          schema: { type: string }
      responses:
        '200': { description: ok }
        '400': { description: INVALID_PARAM }
```

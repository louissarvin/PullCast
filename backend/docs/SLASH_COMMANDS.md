# PullCast Slash Commands

Reference for the discord.js v14 command surface. All commands are registered via `registerCommands()` at boot from the `ALL_COMMANDS` barrel in `src/lib/discord/commands/index.ts`. When `DISCORD_DEV_GUILD_ID` is set, registration is guild-scoped (instant); otherwise it is global (up to one hour to propagate).

Every reply is **ephemeral** (`MessageFlags.Ephemeral`) unless noted. Every embed routes through `embed-builders.ts`, which always calls `buildDisclosureField()` AND `discordEmbedFooter()` so the beta disclosure appears in two places per embed (defense in depth).

Rate limits are atomic Postgres token buckets (`src/lib/rate-limit.ts`). The bucket check fires BEFORE `deferReply()` so an exhausted user never consumes a deferred-reply slot.

---

## `/pullcast`

Top-level group. Source: `src/lib/discord/commands/pullcast.ts`.

### `/pullcast subscribe`

Subscribe the current channel to either a wallet OR a pack. Exactly one of `wallet` / `pack` must be provided.

| Option | Type | Required | Validation |
|--------|------|----------|------------|
| `wallet` | string | one-of | `^0x[a-fA-F0-9]{40}$`, lowercased before storage |
| `pack` | string | one-of | must be in `INDEXER_TRACKED_PACKS` (e.g. `eden-pack`, `omega`, `renacrypt-pack`) |

Example invocations:

```
/pullcast subscribe wallet:0xabcdef0123456789abcdef0123456789abcdef01
/pullcast subscribe pack:eden-pack
```

Success embed (color `0x2ecc71`):

```
Title:       Subscribed
Description: Now watching 0xabcdef... in this channel. Subscription id: `clbsubxxxx...`
Field:       _disclosure spacer
Footer:      Beta data from Renaiss API and Renaiss Index API (experimental). Sources cited. Not financial advice.
```

Refusal cases (rendered via `buildErrorEmbed`, color `0xe74c3c`):
- Both / neither `wallet` and `pack` provided: "Provide exactly one of `wallet:<0x...>` or `pack:<slug>`."
- Wallet regex mismatch: "Wallet must be a 0x-prefixed 40-character hex address."
- Pack not tracked: "Pack must be one of: eden-pack, omega, renacrypt-pack."
- Prisma `P2002` unique violation: "Already subscribed to that target in this channel."
- Outside a guild: "This command must be run in a server channel."

Rate limit: none beyond Discord's built-in interaction throttling.

### `/pullcast unsubscribe`

Soft-delete a subscription owned by the current channel. With no `id`, lists active subscriptions instead so the user can copy an id back.

| Option | Type | Required | Validation |
|--------|------|----------|------------|
| `id` | string | no | subscription cuid; must belong to this channel |

Example:

```
/pullcast unsubscribe
/pullcast unsubscribe id:clbsubxxxxxxxxxxxxxxxxxxx
```

Success embed (color `0xe67e22`): "Removed subscription `<id>` (wallet:0x... | pack:<slug>)."

Refusal cases:
- Unknown id in this channel: "No active subscription with that id in this channel."
- Outside a guild: as above.

Rate limit: none.

### `/pullcast list`

List active subscriptions in this channel. Empty-state embed when nothing is subscribed. Up to 25 rows.

Refusal cases:
- Outside a guild: as above.

### `/pullcast help`

Renders the same help embed as the top-level `/help`. Lists every subcommand with a usage line.

---

## `/help`

Top-level alias for `/pullcast help`. Source: `src/lib/discord/commands/help.ts`. Ephemeral. No options. No rate limit.

---

## `/price`

Source: `src/lib/discord/commands/price.ts`. Defers the reply (15-minute window) because upstream APIs can take 200ms-3s.

Rate limit: per-user `discord:command:price:<userId>`, capacity 5, refill 5 / min. When exhausted, the handler replies (without deferring) with a `Slow down please` embed.

### `/price token`

Renaiss main API + Index API blended FMV.

| Option | Type | Required | Validation |
|--------|------|----------|------------|
| `tokenid` | string | yes | `^[0-9]{1,78}$` (decimal, uint256-safe) |

Behavior:
1. Call `renaissApi.getCard(tokenId)`.
2. Normalize the response, extracting `serial`, `gradingCompany`, `grade` from `attributes[]` (in addition to top-level fields).
3. If a serial is present, call `getOrFetchCert(serial.toUpperCase())` for the Index API graded valuation.
4. Embed renders: `cardName`, `setName`, `grade`, main API FMV, Index API FMV, recommended FMV, confidence, last sale, image, and sources list.
5. Append "No graded cert linked to this token. Showing Renaiss main API FMV only." when serial is absent.
6. Append "Graded record not available right now; showing main API FMV." when serial is present but the Index lookup miss-or-erroreds.
7. Append "FMV variance high (NN%); see sources." when both signals are present and disagree by > 20%.

Example invocation:

```
/price token tokenid:123456
```

Refusal cases:
- TokenId fails regex: "TokenId must be a decimal integer (up to 78 digits, uint256 safe)."
- Renaiss main API 4xx / network: "Token <id> not found or Renaiss API unreachable."

### `/price cert`

Index API graded cert lookup via the cache (`getOrFetchCert`).

| Option | Type | Required | Validation |
|--------|------|----------|------------|
| `cert` | string | yes | `^(PSA\|BGS\|CGC\|SGC)\d{6,12}$`, uppercased |

Example:

```
/price cert cert:PSA73628064
```

Refusal cases:
- Cert format invalid: "Cert format must be PSA/BGS/CGC/SGC followed by 6-12 digits (e.g. PSA73628064)."
- Index API unreachable: "Renaiss Index API unreachable for <cert>. Please try again in a moment."
- Index API returns `found: false`: "No grading record found for <cert>. Try /price token <id> if you have the Renaiss tokenId."

---

## `/odds`

Source: `src/lib/discord/commands/odds.ts`. Defers the reply.

| Option | Type | Required | Choices |
|--------|------|----------|---------|
| `pack` | string | yes | populated at command-build time from `INDEXER_TRACKED_PACKS` (first 25). Off-list values are rejected. |

Rate limit: per-user `discord:command:odds:<userId>`, capacity 10, refill 10 / min.

Behavior:
1. Validate pack against `INDEXER_TRACKED_PACKS`. Off-list: reply with error embed without deferring.
2. Call `computeOddsStats(pack)` (shared with the REST route, in `src/lib/odds/index.ts`).
3. When `totalPulls < 10`: error embed "Not enough data for <pack> yet (n=<n>). Check back later." No bogus aggregates.
4. Otherwise render `buildOddsEmbed`: title `Pull odds: <slug>`, color green, mean / median / sample-size inline fields, top 5 numbered list with grade label, by-tier breakdown (only non-null netGain tiers), disclosure spacer, footer.

Example:

```
/odds pack:eden-pack
```

Refusal cases:
- Off-list pack: "Pack \"<input>\" is not tracked by PullCast. Tracked packs: eden-pack, omega, renacrypt-pack."
- Insufficient sample (n < 10): see above.

---

## `/explain`

Source: `src/lib/discord/commands/explain.ts`. Defers the reply.

Rate limit: per-user `discord:command:ai:<userId>`, capacity 3, refill 3 / min. **Shared with `/listing`** so a chatty user cannot dodge by alternating commands. Exhausted users get an immediate "Slow down please" without deferring.

### `/explain cert`

| Option | Type | Required | Validation |
|--------|------|----------|------------|
| `cert` | string | yes | `^(PSA\|BGS\|CGC\|SGC)\d{6,12}$`, uppercased |
| `question` | string | yes | 5-800 chars after trim |

### `/explain token`

| Option | Type | Required | Validation |
|--------|------|----------|------------|
| `tokenid` | string | yes | `^[0-9]{1,78}$` |
| `question` | string | yes | 5-800 chars after trim |

Behavior (pipeline in `src/lib/anthropic/explain.ts`):
1. **Predictive-question regex.** Matches `should I buy`, `will it (pump|moon|appreciate)`, `moonshot`, `worth buying`, etc. Refuse immediately. Anthropic is never called; no Renaiss API call is made either.
2. Retriever (`gatherSourcesForCert` / `gatherSourcesForTokenId`) returns Source[] from real Renaiss / Index API endpoints plus the curated corpus (`src/lib/anthropic/corpus-seeds.ts`).
3. Refuse if `sources.length < 2`.
4. Budget gate (`assertTokenBudget`, daily ledger backed by `RateLimitBucket` with key `anthropic:tokens:YYYYMMDD`).
5. Anthropic Haiku call with `SYSTEM_EXPLAIN` prompt.
6. `stripUnreferencedCitations` removes `[source-N]` markers whose N is not in the allowed source ID set.
7. `enforceCitations`: refuse on `uncited-claim` (any non-empty paragraph without a citation) or `empty-response`.
8. `appendDisclosureFooter`.

Example success embed (color blue):

```
Title:       /explain — cert PSA73628064
Description: (the AI text, two paragraphs with [source-1] [source-2] markers)
Field:       Sources
             [source-1] Renaiss Index API: PSA73628064 (https://api.renaissos.com/v1/graded/PSA73628064)
             [source-2] Renaiss main API: ... (https://api.renaiss.xyz/v0/...)
Field:       _disclosure spacer
Footer:      Beta data from Renaiss API and Renaiss Index API ...
```

Refusal embed (color red, title "Refused"):
- `predictive-question`: "PullCast does not make price predictions. Try a descriptive question (e.g. 'What is this card?', 'What grade is it?')."
- `insufficient-sources`: "Not enough source material to ground an answer for this query."
- `uncited-claim`: "The model wrote a claim without a citation. We do not publish ungrounded answers."
- `empty-response`: same as uncited-claim.
- `budget-exhausted`: "AI budget for today is exhausted. Try again tomorrow."

---

## `/listing`

Source: `src/lib/discord/commands/listing.ts`. Defers the reply. Shares the `discord:command:ai:<userId>` bucket with `/explain`.

### `/listing cert`

| Option | Type | Required | Validation |
|--------|------|----------|------------|
| `cert` | string | yes | `^(PSA\|BGS\|CGC\|SGC)\d{6,12}$` |

### `/listing token`

| Option | Type | Required | Validation |
|--------|------|----------|------------|
| `tokenid` | string | yes | `^[0-9]{1,78}$` |

Behavior (in `src/lib/anthropic/listing.ts`):
1. Resolve the card (cert -> Index API; token -> main API + cert bridge if serial present).
2. `computeRange` (pure math): low = 90th-percentile-discounted comp band low, mid = recommended FMV, high = liquidity-premium top. AI never sees the output ranges before they are emitted.
3. Budget gate.
4. Anthropic Haiku writes only the explanation, instructed to use the given numbers exactly.
5. Citation guard pipeline identical to `/explain`.

Example success embed: title "Suggested listing range", three inline fields `Fast / Fair / Max` with formatted USD, comparable count, primary FMV source label, AI explanation with `[source-N]` markers, sources list, disclosure footer.

Refusal cases:
- Same as `/explain` plus:
  - `insufficient-comparables`: not enough trade history to compute a defensible range.

---

## Auto-share embed (not a slash command, but user-visible)

When the indexer persists a new Pull AND the buyer wallet is not in `OptOut` AND at least one `Subscription` matches the wallet OR pack, `postPullToSubscribers` (`src/lib/discord/share-card-poster.ts`) renders the share card once and fans out to every matching channel. Each post is:

- An ephemeral=false embed built by `buildPullEmbed`.
- A PNG attachment from the cached share card (`tmp/share-cards/<pullId>-<variant>.png`).
- An action row with `Share to X`, `View on Renaiss`, and `Opt out` link buttons (`buildPullActionRow`).
- Per-channel atomic rate limit `discord:channel:<id>` (default 10 posts / min, controlled by `DISCORD_POST_RATE_PER_CHANNEL_PER_MIN`).
- Bad channels (deleted, no permission) trigger soft-delete of the Subscription row.

The embed footer is the full disclosure. The watermark on the PNG itself is `DISCLOSURE_WATERMARK` (`Beta · pullcast.xyz`).

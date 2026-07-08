# PullCast 90-Second Loom Script

How-to for the submission Loom recording. Target duration: 90 seconds. Pacing: a new beat every 8-15 seconds, no dead air. Recommended one take, max three cuts.

Pre-recording checklist (do all of these before hitting Record):

- [ ] Backend is running locally with `bun run dev`. `bun run db:push` has been run at least once.
- [ ] `.env` has real `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, `DISCORD_DEV_GUILD_ID`, and `ANTHROPIC_API_KEY`.
- [ ] Bot is installed and online in a fresh test Discord server with one text channel pinned to top.
- [ ] At least one whale wallet is pre-subscribed via `/pullcast subscribe wallet:0xWHALE` so the auto-share beat can fire.
- [ ] Seed a known Pull row in the DB (or wait for a real pull) so `/og/:pullId`, `/price`, and `/explain` have data to chew on.
- [ ] Leaderboard worker has computed at least one snapshot. Restart the server if needed (the worker pre-computes 10s after boot).
- [ ] Browser tab open to the OAuth install URL (`getInstallUrl()` from `src/lib/discord/oauth.ts` once implemented, or the developer-portal install URL for the bot). Hidden behind a window for 0:08.
- [ ] Three or four prior auto-share embeds are already in the test channel so the channel does not look empty in establishing shots.
- [ ] Discord notifications muted on the recording machine.

---

## Beat-by-beat

### 0:00-0:08 — Hook (title card)

- **What to show:** A title slide with `PullCast` + tagline `First community Discord client of the Renaiss API` + three dates: `Jun 28 SDK · Jul 4 first commit · Jul 11 submission`. Cuts to live screen at exactly 0:08.
- **What to say (verbatim):** "Two days ago, Renaiss shipped their official SDK. Today, PullCast is the first community Discord client built on it."
- **Commands typed:** none.
- **Pre-stage:** title slide rendered ahead of time as an image or Keynote frame.

### 0:08-0:13 — OAuth install

- **What to show:** Browser tab with the bot's OAuth install URL. Click `Authorize PullCast?` -> select the test server -> click Authorize. Discord shows the success page.
- **What to say:** "One install in Discord."
- **Commands typed:** none. Mouse only.
- **Pre-stage:** browser tab pre-loaded at the OAuth confirmation screen.

### 0:13-0:30 — Auto-share headline beat

- **What to show:** Discord channel. Type the subscribe command. Cut to a pre-recorded pack pull on `renaiss.xyz` (15 seconds). Cut back to Discord — the share card auto-appears with the rarity glow and the `+$1,842 net` headline.
- **What to say:** "Subscribe a whale wallet. Watch. When they pull, PullCast posts the share card in seconds."
- **Commands typed:**

```
/pullcast subscribe wallet:0xWHALE_ADDRESS_HERE
```

- **Pre-stage:** the whale wallet has an in-flight pack purchase queued so the share card fires within 30 seconds. The renaiss.xyz pack-opening clip is pre-recorded and ready to cut to.
- **Why this matters:** the visceral demo moment. No other Tool track entry has auto-share-on-pull.

### 0:30-0:45 — `/price`

- **What to show:** Discord channel. Type the slash command. The embed renders showing main API FMV, Index API FMV, recommended FMV, source list with two URLs, footer disclosure.
- **What to say:** "Any card, any time. Renaiss main API and Renaiss Index API cross-referenced. The recommended FMV labeled clearly."
- **Commands typed:**

```
/price token tokenid:123456
```

- **Pre-stage:** tokenId `123456` (replace with a real tracked tokenId) has both a main API record AND a graded cert in the Index API so both FMV columns light up.

### 0:45-0:55 — `/odds`

- **What to show:** Discord embed renders with title `Pull odds: eden-pack`, sample size, mean / median / win rate inline fields, top 5 numbered list, per-tier breakdown.
- **What to say:** "Before you even buy. `/odds` shows ninety days of pull-economy data: sample size, mean P&L, win rate, top five hits."
- **Commands typed:**

```
/odds pack:eden-pack
```

- **Pre-stage:** the indexer has ingested at least 10 pulls for `eden-pack` so the sample-size gate passes (otherwise the embed will read "Not enough data ... n=<n>").

### 0:55-1:10 — `/explain` with citation block

- **What to show:** Discord embed with title `/explain — cert PSA73628064`, two paragraphs of AI-written explanation, every claim followed by `[source-1]` / `[source-2]` markers, a Sources field listing the two URLs (Renaiss main API + Renaiss Index API), disclosure footer.
- **What to say:** "And here is what grounded AI looks like in your Discord today. Every fact carries a citation. Predictive questions like 'should I buy' get refused before the model is even called."
- **Commands typed:**

```
/explain cert cert:PSA73628064 question:"What is this card and what grade did it receive?"
```

- **Pre-stage:** `PSA73628064` is a real graded cert in the Index API. The retriever returns at least two sources for this cert. The Anthropic key has budget remaining (`ANTHROPIC_DAILY_TOKEN_BUDGET` default 250000 tokens / day).
- **Optional follow-up beat (cut if running long):** type `/explain cert cert:PSA73628064 question:"Should I buy this?"` and show the immediate "Refused — PullCast does not make price predictions" embed.

### 1:10-1:20 — Pull-of-the-Day leaderboard

- **What to show:** Cut to a different Discord channel (or browser tab open to `http://localhost:3700/api/leaderboard/daily`) showing the top 5 pulls of the trailing 24 hours, ranked by net gain, with card images and grade labels.
- **What to say:** "Every hour, PullCast publishes the top five pulls of the trailing day. Recurring content for the community. Zero work for the operator."
- **Commands typed:** none (browser tab pre-loaded), or `curl -s http://localhost:3700/api/leaderboard/daily | jq` in a side terminal if you want to show the JSON.
- **Pre-stage:** restart the server within the last 10 minutes so the boot-delay snapshot has populated `LeaderboardSnapshot`.

### 1:20-1:30 — Close

- **What to show:** Quick montage: terminal running `curl http://localhost:3700/og/<pullId> > card.png && open card.png` to flash the OG PNG; phone browser at the gallery URL; end frame with the PullCast logo, OAuth install URL, GitHub repo URL, the line "Touches the Renaiss roadmap: SDK, Auranaiss Intelligence, third-party distribution," and "Renaiss Tech Hackathon S1."
- **What to say:** "Discord, JSON API, OG previews, share-card gallery. Five surfaces from one install. Open source MIT. Built solo in eight days."
- **Commands typed:** none.
- **Pre-stage:** end frame rendered as an image. Terminal command queued in shell history.

---

## Submission checklist (D8, Jul 11, by 12:00 UTC+8)

Per `16_maximization_playbook.md` §9 and §10:

- [ ] Code freeze at 10:00 UTC+8. No new features past this point. Only one-line `bugfix:` commits if a demo path breaks.
- [ ] Final smoke test: all four slash commands (`/price`, `/odds`, `/explain`, `/listing`) in three different Discord servers, plus one web gallery load, plus one `/og/:pullId` PNG fetch.
- [ ] Loom recording uploaded and unlisted-link copied to clipboard.
- [ ] Submission form filled and submitted: https://forms.gle/db9SMNGKMMbTDBLXA
- [ ] GitHub repo public, MIT license file present, README hitting all five judging criteria, contract addresses cited, demo URL working, Loom URL embedded.
- [ ] Submission tweet thread posted, tagging `@tastedotmd`, `@renaissxyz`, `@RenaissCLTB`.
- [ ] Discord drop in the Renaiss `#showcase` (or `#builders`) channel.
- [ ] At least 10 real share cards generated from real wallets (counts as evidence-of-adoption).
- [ ] Bot installed in at least 3 real Discord servers.
- [ ] Adoption metrics added to README (cards shared, gallery views if any, ambassador shoutouts if any).

Post-submission (Jul 12-14, judging period):

- Respond to every comment within 30 minutes.
- Do NOT DM judges unsolicited.
- Publish one organic milestone update if a metric crosses (e.g. "100 wallets subscribed in 24h" with screenshot).
- Schedule a follow-up Twitter Space for Jul 18 (post-results), regardless of outcome.

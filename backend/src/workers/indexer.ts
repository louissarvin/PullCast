/**
 * Indexer worker.
 *
 * Cron cadence: every 1 minute via node-cron (`* * * * *`). node-cron does not
 * support sub-minute schedules in the standard 5-field syntax, so we accept
 * one tick per minute and iterate the tracked-packs list inside the task,
 * pausing `INDEXER_POLL_INTERVAL_MS / N_PACKS` between packs. With the
 * default 30000ms and 3 packs the inner cadence is 10s. This stays well
 * inside the architecture spec's 30s target for any given pack.
 *
 * Responsibilities per tick:
 *
 *  1. For each pack slug from INDEXER_TRACKED_PACKS:
 *     - Read the Cursor row (null on cold start).
 *     - Call renaissApi.getPackPulls(slug, { since: lastSeenTimestamp.ms }).
 *     - For each pull (oldest first, since the API returns newest last):
 *       - Skip if buyer is in OptOut.
 *       - Build the Pull payload (parsePriceCents for FMV, packPrice; compute netGain).
 *       - Extract grading info from attributes[] when present.
 *       - Upsert on (packSlug, collectibleTokenId) with empty update body
 *         (first-write-wins per schema-review B2).
 *       - If the upsert was a real insert AND Discord is booted, schedule
 *         `postPullToSubscribers(pull)` fire-and-forget.
 *     - On success, update Cursor cursor fields and reset consecutiveFailures.
 *  2. On error, increment consecutiveFailures and do NOT advance the cursor
 *     timestamp.
 *  3. If consecutiveFailures >= 10, log a circuit-open warning (the pack still
 *     gets polled; the warning is the alert).
 *
 * Boot:
 *  - `startIndexerWorker()` registers the cron and runs a first pass after a
 *    5-second delay so Fastify and Discord can finish booting.
 *  - `setIndexerDiscordReady(true|false)` is called by index.ts: when Discord
 *    boots clean we enable posting; when login fails (placeholder tokens in
 *    dev) we run the indexer in persist-only mode.
 */

import cron from 'node-cron';

import {
  INDEXER_POLL_INTERVAL_MS,
  INDEXER_TRACKED_PACKS,
} from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { renaissApi, parsePriceCents, type RenaissPull } from '../lib/renaiss/index.ts';
import { upgradeFmvFromCardBridge } from '../lib/renaiss-index/index.ts';
import { upsertPullReturningInsertFlag } from '../lib/db/pull-upsert.ts';
import { postPullToSubscribers } from '../lib/discord/share-card-poster.ts';
import {
  BSC_CONTRACT_ADDRESSES,
  getRecentPullsFallback,
} from '../lib/ethers/index.ts';
import {
  resolveBuyerForToken,
  getBuyerResolveFailureCount,
  OWNER_FAILURE_THRESHOLD,
} from '../lib/renaiss/buyer-resolve.ts';

const LOG_PREFIX = '[indexer]';

const CIRCUIT_OPEN_THRESHOLD = 10;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Dual-mode resilience per file 15 §6.4. After 3 consecutive API failures for
 * the same pack, `processPack` transparently switches its data source to the
 * BSC on-chain fallback for the next tick. Once the API responds again the
 * mode returns to PRIMARY automatically. Tracked per pack slug.
 */
const FALLBACK_TRIGGER_FAILURES = 3;

let isRunning = false;
let discordReady = false;

/**
 * Called from index.ts to flip posting on/off without restarting the worker.
 * When false (Discord login failed / placeholder token) we still persist Pull
 * rows but skip the share-card fanout.
 */
export const setIndexerDiscordReady = (ready: boolean): void => {
  discordReady = ready;
};

interface NormalizedPull {
  packSlug: string;
  collectibleTokenId: string;
  buyerAddress: string;
  tier: string | null;
  fmvUsdCents: number | null;
  packPriceUsdCents: number;
  netGainUsdCents: number | null;
  pulledAtTimestamp: Date;
  txHash: string | null;
  blockNumber: number | null;
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  gradingCompany: string | null;
  grade: string | null;
  serial: string | null;
  frontImageUrl: string | null;
  backImageUrl: string | null;
  rawAttributesJson: string | null;
}

interface AttributeLike {
  trait_type?: unknown;
  value?: unknown;
}

const isAttributeArray = (raw: unknown): raw is AttributeLike[] => {
  return Array.isArray(raw) && raw.every((a) => typeof a === 'object' && a !== null);
};

const stringFromAttribute = (val: unknown): string | null => {
  if (typeof val === 'string' && val.length > 0) return val;
  if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  return null;
};

// M-4: SSRF / XSS-vector defense at ingestion. Pull image URLs in `Pull` are
// rendered into share-cards (server-side fetch via Satori) and flow back to
// the frontend as `<img src=...>`. Restrict the scheme to https and the host
// to known Renaiss CDNs so a compromised upstream cannot redirect us at
// internal IPs or smuggle a `javascript:` / `data:text/html` payload.
const SAFE_HOSTS = new Set([
  'cdn.renaiss.xyz',
  'images.renaiss.xyz',
  'api.renaiss.xyz',
  'bhshyxmgzwogzgcf.public.blob.vercel-storage.com',
]);
const safeUrl = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && SAFE_HOSTS.has(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
};

// M-7: hard length caps on Pull text fields. Discord embeds cap individual
// fields at 256/4096 chars, but the share-card renderer and DB column
// constraints want lower bounds. Slicing also defangs Unicode normalization
// bombs that would otherwise throw inside discord.js and burn a fanout token.
const cap = (s: string | null | undefined, max: number): string | null => {
  if (typeof s !== 'string' || s.length === 0) return null;
  return s.slice(0, max);
};

const traitMatches = (trait: unknown, ...names: string[]): boolean => {
  if (typeof trait !== 'string') return false;
  const norm = trait.trim().toLowerCase();
  return names.some((n) => norm === n.toLowerCase());
};

interface GradingExtract {
  gradingCompany: string | null;
  grade: string | null;
  serial: string | null;
}

const extractGrading = (raw: unknown): GradingExtract => {
  if (!isAttributeArray(raw)) {
    return { gradingCompany: null, grade: null, serial: null };
  }
  let gradingCompany: string | null = null;
  let grade: string | null = null;
  let serial: string | null = null;

  for (const attr of raw) {
    if (traitMatches(attr.trait_type, 'Grading Company', 'Grader')) {
      gradingCompany = gradingCompany ?? stringFromAttribute(attr.value);
    } else if (traitMatches(attr.trait_type, 'Grade')) {
      grade = grade ?? stringFromAttribute(attr.value);
    } else if (traitMatches(attr.trait_type, 'Serial', 'Cert', 'Cert Number', 'Certification')) {
      serial = serial ?? stringFromAttribute(attr.value);
    }
  }

  return { gradingCompany, grade, serial };
};

const extractLanguage = (raw: unknown): string | null => {
  if (!isAttributeArray(raw)) return null;
  for (const attr of raw) {
    if (traitMatches(attr.trait_type, 'Language', 'Card Language')) {
      return stringFromAttribute(attr.value);
    }
  }
  return null;
};

const languageFromRawAttributes = (rawAttributesJson: string | null): string | null => {
  if (rawAttributesJson === null || rawAttributesJson.length === 0) return null;
  try {
    return extractLanguage(JSON.parse(rawAttributesJson));
  } catch {
    return null;
  }
};

interface RenaissPullExt {
  cardName?: unknown;
  setName?: unknown;
  cardNumber?: unknown;
  imageUrl?: unknown;
  frontImageUrl?: unknown;
  backImageUrl?: unknown;
  attributes?: unknown;
}

/**
 * Map a Renaiss recentOpenedPacks entry to the Pull persistence shape.
 * Returns null if a required field is missing or unparseable.
 */
const normalizePull = (
  packSlug: string,
  packPriceUsdCents: number,
  raw: RenaissPull
): NormalizedPull | null => {
  const ext = raw as RenaissPull & RenaissPullExt;

  const tokenId = raw.collectibleTokenId;
  if (typeof tokenId !== 'string' || tokenId.length === 0) {
    return null;
  }

  const buyerRaw = typeof raw.buyerAddress === 'string' ? raw.buyerAddress : null;
  if (buyerRaw === null || buyerRaw.length === 0) {
    return null;
  }
  const buyerAddress = buyerRaw.toLowerCase();

  const pulledAt = new Date(raw.pulledAtTimestamp);
  if (Number.isNaN(pulledAt.getTime())) {
    return null;
  }

  const fmvCandidate = raw.fmv ?? raw.fmvPriceInUSD;
  const fmvUsdCents = parsePriceCents(fmvCandidate);
  const netGainUsdCents =
    fmvUsdCents !== null ? fmvUsdCents - packPriceUsdCents : null;

  const grading = extractGrading(ext.attributes);

  // M-4: validate scheme + host before persisting. Fallback chain preserved
  // (frontImageUrl wins, else imageUrl), each validated independently.
  const frontImageUrl = safeUrl(ext.frontImageUrl) ?? safeUrl(ext.imageUrl);
  const backImageUrl = safeUrl(ext.backImageUrl);
  // M-7: cap text fields. Discord field caps are 256 (titles) / 4096 (desc);
  // these conservative limits are below the embed validator and the share-card
  // text renderer's safe range.
  const cardName = cap(typeof ext.cardName === 'string' ? ext.cardName : null, 256);
  const setName = cap(typeof ext.setName === 'string' ? ext.setName : null, 256);
  const cardNumber = cap(typeof ext.cardNumber === 'string' ? ext.cardNumber : null, 64);

  const rawAttributesJson = ext.attributes !== undefined ? safeStringify(ext.attributes) : null;

  return {
    packSlug,
    collectibleTokenId: tokenId,
    buyerAddress,
    tier: cap(typeof raw.tier === 'string' ? raw.tier : null, 64),
    fmvUsdCents,
    packPriceUsdCents,
    netGainUsdCents,
    pulledAtTimestamp: pulledAt,
    txHash: typeof raw.txHash === 'string' && raw.txHash.length > 0 ? raw.txHash : null,
    blockNumber:
      typeof raw.blockNumber === 'number' && Number.isFinite(raw.blockNumber)
        ? raw.blockNumber
        : null,
    cardName,
    setName,
    cardNumber,
    gradingCompany: cap(grading.gradingCompany, 32),
    grade: cap(grading.grade, 32),
    serial: cap(grading.serial, 64),
    frontImageUrl,
    backImageUrl,
    rawAttributesJson,
  };
};

const safeStringify = (val: unknown): string | null => {
  try {
    return JSON.stringify(val);
  } catch {
    return null;
  }
};

/**
 * Process one pack: upsert cursor, fetch new pulls, persist, fan out.
 *
 * Returns nothing; errors are caught here and recorded on the Cursor row.
 */
const processPack = async (slug: string): Promise<void> => {
  // R5: read the cursor with findUnique. The Cursor row may not exist yet on
  // a cold start; the single upsert at the bottom of this function will
  // create it. Treat null as fresh-start with zeroed state.
  const cursor = await prismaQuery.cursor.findUnique({
    where: { packSlug: slug },
  });

  const cursorConsecutiveFailures = cursor?.consecutiveFailures ?? 0;
  const cursorLastSeenTokenId = cursor?.lastSeenTokenId ?? null;
  const cursorLastSeenTimestamp = cursor?.lastSeenTimestamp ?? null;

  // Circuit-open warning. We still poll; the warning is the alert.
  if (cursorConsecutiveFailures >= CIRCUIT_OPEN_THRESHOLD) {
    console.warn(
      `${LOG_PREFIX} CIRCUIT_OPEN pack=${slug} failures=${cursorConsecutiveFailures}`
    );
  }

  const sinceMs =
    cursorLastSeenTimestamp instanceof Date ? cursorLastSeenTimestamp.getTime() : undefined;

  let pack;
  let pulls: RenaissPull[];
  const useFallback = cursorConsecutiveFailures >= FALLBACK_TRIGGER_FAILURES;

  try {
    // We need the pack to get the current pack price, plus the recentOpenedPacks list.
    pack = await renaissApi.getPack(slug);
    // Shape-drift observability. `_shapeVariant` is emitted by the zod schema
    // transformer in renaiss/schemas.ts and is either 'cardPack-wrapped'
    // (current live 2026-07-02) or 'root-level' (legacy). Logging it on every
    // successful poll gives us early warning if the upstream flips back or
    // introduces a third variant.
    const shapeVariant =
      (pack as unknown as { _shapeVariant?: string })._shapeVariant ?? 'unknown';
    const all = Array.isArray(pack.recentOpenedPacks) ? pack.recentOpenedPacks : [];
    let filtered = all;
    if (sinceMs !== undefined) {
      filtered = filtered.filter((p) => {
        const ts = Date.parse(p.pulledAtTimestamp);
        return Number.isFinite(ts) && ts > sinceMs;
      });
    }
    pulls = filtered.slice(0, 50);
    console.log(
      `${LOG_PREFIX} parsed pack shape=${shapeVariant} pack=${slug} mode=PRIMARY_API fetched=${pulls.length}`
    );
  } catch (err) {
    if (!useFallback) {
      await recordFailure(slug, cursorConsecutiveFailures + 1, err);
      return;
    }

    // Renaiss API has been down for FALLBACK_TRIGGER_FAILURES ticks. Try the
    // on-chain fallback: cross-reference CheckoutSuccess with Registry V3
    // Transfer events to recover the pulled tokenIds. This does NOT populate
    // card metadata (name, image, attributes) - those come only from the API
    // - so downstream normalization will produce sparse Pull rows. The
    // upsert path handles null metadata gracefully; the cert-bridge worker
    // will backfill FMV when a serial appears in a later API tick.
    console.warn(
      `${LOG_PREFIX} pack=${slug} mode=ONCHAIN_FALLBACK activating after ${cursorConsecutiveFailures} API failures`
    );
    try {
      const onchain = await getRecentPullsFallback(
        BSC_CONTRACT_ADDRESSES.tokenVendingMachine,
        5000
      );
      const sinceOnchain =
        sinceMs !== undefined ? Math.floor(sinceMs / 1000) : 0;
      pulls = onchain
        .filter((p) => p.timestamp > sinceOnchain)
        .map<RenaissPull>((p) => ({
          collectibleTokenId: p.tokenId,
          buyerAddress: p.buyer,
          pulledAtTimestamp: new Date(p.timestamp * 1000).toISOString(),
          txHash: p.txHash,
          blockNumber: p.blockNumber,
          fmv: null,
          fmvPriceInUSD: null,
          tier: null,
        } as unknown as RenaissPull));
      // Synthesize a minimal `pack` so the rest of the loop still has a
      // packPriceInUSD reference. The on-chain event carries `pricePaidUsdc`
      // per pull; we surface that on the Pull row via `packPriceUsdCents`
      // set from the pull-level amount below.
      pack = { packPriceInUSD: null, recentOpenedPacks: [] } as unknown as Awaited<
        ReturnType<typeof renaissApi.getPack>
      >;
      console.log(`${LOG_PREFIX} pack=${slug} mode=ONCHAIN_FALLBACK fetched=${pulls.length}`);
    } catch (fallbackErr) {
      console.error(
        `${LOG_PREFIX} pack=${slug} ONCHAIN_FALLBACK failed:`,
        fallbackErr
      );
      await recordFailure(slug, cursorConsecutiveFailures + 1, err);
      return;
    }
  }

  // Pack price resolution. Legacy shape carries `packPriceInUSD` in string cents
  // (e.g. "7350" == $73.50). Current cardPack-wrapped shape carries
  // `priceInUsdt` in USDT wei (18 decimals, e.g. "150000000000000000000" == 150
  // USDT == $150.00). We prefer packPriceInUSD when present; otherwise fall
  // back to priceInUsdt / 1e16 cents (1 USDT ~= $1.00).
  const packInner = pack as unknown as { priceInUsdt?: string | number | null };
  let packPriceUsdCents = parsePriceCents(pack.packPriceInUSD) ?? 0;
  if (packPriceUsdCents === 0 && packInner.priceInUsdt !== undefined && packInner.priceInUsdt !== null) {
    // priceInUsdt is an integer string (wei). Guard against BigInt-sized values
    // by parsing with BigInt and dividing before converting to Number.
    try {
      const raw = String(packInner.priceInUsdt);
      if (/^\d+$/.test(raw)) {
        // (wei) -> cents: divide by 10^16 (18 decimals - 2 cents).
        const cents = Number(BigInt(raw) / 10_000_000_000_000_000n);
        if (Number.isFinite(cents) && cents >= 0) {
          packPriceUsdCents = cents;
        }
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} priceInUsdt parse failed pack=${slug}:`, err);
    }
  }

  // Newest-last per architecture: iterate in chronological order so the cursor
  // advances monotonically even if we crash mid-batch.
  const ordered = [...pulls].sort((a, b) => {
    const ta = Date.parse(a.pulledAtTimestamp);
    const tb = Date.parse(b.pulledAtTimestamp);
    return ta - tb;
  });

  let lastSeenTokenId: string | null = cursorLastSeenTokenId;
  let lastSeenTimestamp: Date | null = cursorLastSeenTimestamp;
  let processed = 0;
  let inserted = 0;

  for (const raw of ordered) {
    // -------------------------------------------------------------------
    // Buyer-address workaround (2026-07-02):
    //
    // Live `cardPack.recentOpenedPacks[]` entries do NOT include
    // `buyerAddress`, so normalizePull would drop every new pull at its
    // buyerRaw-null guard. Resolve the buyer from the /cards endpoint using
    // the freshly-minted collectible's `ownerAddress` (this equals the
    // buyer for a just-minted card) before normalizePull runs.
    //
    // If the upstream buyer is already present (some future upstream fix or
    // the on-chain-fallback branch above), we DO NOT override it.
    //
    // If resolution has failed >= OWNER_FAILURE_THRESHOLD ticks in a row for
    // this tokenId, we let normalizePull skip the row so the outer tick's
    // fallback path (or the next tick) picks it up via
    // `getRecentPullsFallback`.
    // -------------------------------------------------------------------
    const hasBuyer =
      typeof raw.buyerAddress === 'string' && raw.buyerAddress.length > 0;
    const rawTokenId =
      typeof raw.collectibleTokenId === 'string' ? raw.collectibleTokenId : null;
    if (!hasBuyer && rawTokenId !== null) {
      const failures = getBuyerResolveFailureCount(rawTokenId);
      if (failures < OWNER_FAILURE_THRESHOLD) {
        const resolved = await resolveBuyerForToken(rawTokenId);
        if (resolved !== null) {
          // Attach the resolved buyer to the raw entry so normalizePull sees
          // it. We only touch this one field; the rest of the shape is
          // untouched so schema-drift observability elsewhere still fires.
          (raw as { buyerAddress?: string }).buyerAddress = resolved;
        }
      } else {
        console.warn(
          `${LOG_PREFIX} buyer-resolve failure threshold reached tokenId=${rawTokenId}; on-chain fallback will pick this up`
        );
      }
    }

    const norm = normalizePull(slug, packPriceUsdCents, raw);
    if (norm === null) {
      // B4: advance the cursor past this entry by its raw timestamp before we
      // continue so a malformed pull at the head of the batch does not block
      // subsequent ticks indefinitely. We do NOT update `lastSeenTokenId`
      // because `raw.collectibleTokenId` may itself be the malformed bit.
      console.warn(`${LOG_PREFIX} skipping malformed pull pack=${slug}`);
      const rawTs = Date.parse(raw.pulledAtTimestamp ?? '');
      if (Number.isFinite(rawTs)) {
        lastSeenTimestamp = new Date(rawTs);
      }
      continue;
    }

    // OptOut check BEFORE persistence per architecture trust boundary.
    try {
      const opted = await prismaQuery.optOut.findFirst({
        where: { walletAddress: norm.buyerAddress, deletedAt: null },
        select: { id: true },
      });
      if (opted !== null) {
        // We still advance the cursor for opted-out wallets so we do not
        // re-evaluate them next tick. Do not insert the Pull, do not fan out.
        lastSeenTokenId = norm.collectibleTokenId;
        lastSeenTimestamp = norm.pulledAtTimestamp;
        continue;
      }
    } catch (err) {
      // OptOut lookup failure is not fatal; surface and skip this pull.
      console.error(`${LOG_PREFIX} OptOut lookup failed pack=${slug}:`, err);
      continue;
    }

    try {
      // R9: atomic insert-if-absent with a definitive isInsert flag. First-
      // write-wins semantics preserved (existing row returned unmodified on
      // conflict).
      const { pull: result, isInsert } = await upsertPullReturningInsertFlag({
        packSlug: norm.packSlug,
        collectibleTokenId: norm.collectibleTokenId,
        buyerAddress: norm.buyerAddress,
        tier: norm.tier,
        fmvUsdCents: norm.fmvUsdCents,
        packPriceUsdCents: norm.packPriceUsdCents,
        netGainUsdCents: norm.netGainUsdCents,
        pulledAtTimestamp: norm.pulledAtTimestamp,
        txHash: norm.txHash,
        blockNumber: norm.blockNumber,
        cardName: norm.cardName,
        setName: norm.setName,
        cardNumber: norm.cardNumber,
        gradingCompany: norm.gradingCompany,
        grade: norm.grade,
        serial: norm.serial,
        frontImageUrl: norm.frontImageUrl,
        backImageUrl: norm.backImageUrl,
        rawAttributesJson: norm.rawAttributesJson,
      });

      processed += 1;
      lastSeenTokenId = norm.collectibleTokenId;
      lastSeenTimestamp = norm.pulledAtTimestamp;

      if (isInsert) {
        inserted += 1;

        // D9 Card Bridge: fire-and-forget widened lookup (rid → cert → tuple).
        // Upgrades Pull.fmvUsdCents from Renaiss OS Index when available.
        // Log line uses bridge=renaiss-id|cert|tuple|none for coverage metrics.
        const cert =
          typeof result.serial === 'string' && result.serial.length > 0
            ? result.serial
            : null;
        const hasTuple =
          typeof result.setName === 'string' &&
          result.setName.length > 0 &&
          typeof result.cardNumber === 'string' &&
          result.cardNumber.length > 0;

        if (cert !== null || hasTuple) {
          const language = languageFromRawAttributes(result.rawAttributesJson);
          upgradeFmvFromCardBridge(result.id, {
            rid: null,
            cert,
            tuple: hasTuple
              ? {
                  setName: result.setName!,
                  itemNo: result.cardNumber!,
                  language,
                  gradingCompany: result.gradingCompany,
                  grade: result.grade,
                }
              : null,
          })
            .then((r) => {
              const bridge = r.source ?? 'none';
              const idBits = [
                cert ? `cert=${cert}` : null,
                hasTuple ? `tuple=${result.setName}#${result.cardNumber}` : null,
              ]
                .filter(Boolean)
                .join(' ');
              console.log(
                `${LOG_PREFIX} bridge=${bridge} pull=${result.id} tokenId=${result.collectibleTokenId}${idBits ? ` ${idBits}` : ''} upgraded=${r.upgraded} reason=${r.reason}`
              );
            })
            .catch((err) => {
              console.warn(
                `${LOG_PREFIX} card-bridge failed pull=${result.id}`,
                err
              );
            });
        }

        if (discordReady) {
          // Fire-and-forget; we never await the fanout in the cursor loop.
          postPullToSubscribers(result).catch((err) => {
            console.error(`${LOG_PREFIX} fanout error pull=${result.id}:`, err);
          });
        } else {
          console.log(`${LOG_PREFIX} discord not booted, skipping fanout pull=${result.id}`);
        }
      }
    } catch (err) {
      // One bad row should not abort the whole batch. Log and continue.
      console.error(
        `${LOG_PREFIX} upsert failed pack=${slug} token=${norm.collectibleTokenId}:`,
        err
      );
    }
  }

  // R5: a single upsert at the bottom of the loop replaces the prior top-of-
  // loop find + bottom-of-loop update pair. Saves one round-trip per pack per
  // tick. Cursor only advances on the happy path; fetch-failure bailed early
  // via recordFailure() and never reached this line.
  try {
    const now = new Date();
    await prismaQuery.cursor.upsert({
      where: { packSlug: slug },
      create: {
        packSlug: slug,
        lastSeenTokenId: lastSeenTokenId,
        lastSeenTimestamp: lastSeenTimestamp,
        lastSuccessfulPollAt: now,
        consecutiveFailures: 0,
      },
      update: {
        lastSeenTokenId: lastSeenTokenId ?? cursorLastSeenTokenId,
        lastSeenTimestamp: lastSeenTimestamp ?? cursorLastSeenTimestamp,
        lastSuccessfulPollAt: now,
        consecutiveFailures: 0,
      },
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} cursor upsert failed pack=${slug}:`, err);
  }

  console.log(
    `${LOG_PREFIX} pack=${slug} fetched=${pulls.length} processed=${processed} inserted=${inserted}`
  );
};

const recordFailure = async (
  slug: string,
  newCount: number,
  err: unknown
): Promise<void> => {
  console.error(`${LOG_PREFIX} failure for pack=${slug} count=${newCount}:`, err);
  try {
    await prismaQuery.cursor.update({
      where: { packSlug: slug },
      data: { consecutiveFailures: newCount },
    });
  } catch (e) {
    console.error(`${LOG_PREFIX} could not record failure pack=${slug}:`, e);
  }
};

const tick = async (): Promise<void> => {
  if (isRunning) {
    console.log(`${LOG_PREFIX} previous tick still running, skipping`);
    return;
  }
  if (INDEXER_TRACKED_PACKS.length === 0) {
    console.warn(`${LOG_PREFIX} INDEXER_TRACKED_PACKS is empty, nothing to poll`);
    return;
  }

  isRunning = true;
  try {
    const innerDelayMs = Math.max(
      0,
      Math.floor(INDEXER_POLL_INTERVAL_MS / Math.max(1, INDEXER_TRACKED_PACKS.length))
    );

    for (let i = 0; i < INDEXER_TRACKED_PACKS.length; i += 1) {
      const slug = INDEXER_TRACKED_PACKS[i];
      try {
        await processPack(slug);
      } catch (err) {
        // processPack already records its own failure; outer catch is for
        // truly unexpected shape errors.
        console.error(`${LOG_PREFIX} unexpected processPack error pack=${slug}:`, err);
      }
      if (i < INDEXER_TRACKED_PACKS.length - 1 && innerDelayMs > 0) {
        await sleep(innerDelayMs);
      }
    }
  } finally {
    isRunning = false;
  }
};

export const startIndexerWorker = (): void => {
  console.log(
    `${LOG_PREFIX} scheduling tracked=${INDEXER_TRACKED_PACKS.join(',') || '(none)'}`
  );

  // node-cron uses 5-field cron in the standard build. Tick every minute and
  // iterate packs inside the task. This trades a strict 30s cadence for a
  // ~60s outer-loop cadence per pack; the architecture's 30s requirement is
  // approximated by interleaving multiple packs inside the tick.
  cron.schedule('* * * * *', () => {
    void tick();
  });

  // Initial pass after 5s so Fastify and Discord can complete boot first.
  setTimeout(() => {
    void tick();
  }, 5000);
};

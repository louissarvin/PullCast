/**
 * Share-card posting pipeline.
 *
 * Two public entry points:
 *
 *  - `getOrRenderShareCard(pullId, styleVariant?)`: idempotent render+cache.
 *    First look at the ShareCard table; if a row exists and the PNG file is
 *    still on disk, return it. Otherwise render via the share-card module,
 *    write the PNG to `./tmp/share-cards/`, insert a ShareCard row, return.
 *
 *  - `postPullToSubscribers(pull)`: fan-out posting. Given a freshly inserted
 *    Pull row, find every matching Subscription (wallet OR pack scope), check
 *    per-channel rate limit, fetch the channel via the Discord client, build
 *    embed + action row, attach the PNG, send. One failing channel does not
 *    stop the others.
 *
 * Safety rails:
 *  - OptOut is checked by the indexer BEFORE this is called. Defense-in-depth
 *    means we tolerate the indexer skipping the check but still log a warning.
 *  - Rate limiting goes through the atomic `consumeRateLimitToken` so multiple
 *    pulls landing at once cannot stampede a channel.
 *  - A "channel not text-capable" finding soft-deletes the offending
 *    Subscription so we stop trying.
 *  - All errors are caught per-subscription; we keep going.
 */

import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

import type { Pull } from '../../../prisma/generated/client.js';
import { DISCORD_POST_RATE_PER_CHANNEL_PER_MIN } from '../../config/main-config.ts';
import { prismaQuery } from '../prisma.ts';
import { consumeRateLimitToken } from '../rate-limit.ts';
import { extractShareCardInputFromPull } from '../share-card/from-pull.ts';
import { detectStyle, renderShareCard } from '../share-card/render.ts';
import type { ShareCardStyleVariant } from '../share-card/types.ts';
import { getDiscordClient } from './client.ts';
import { buildPullActionRow } from './action-rows.ts';
import { buildPullEmbed, type PullEmbedInput } from './embed-builders.ts';

const LOG_PREFIX = '[poster]';

const SHARE_CARD_DIR = resolve(process.cwd(), 'tmp', 'share-cards');

interface RenderResult {
  pngPath: string;
  buffer: Buffer;
  byteSize: number;
  styleVariant: ShareCardStyleVariant;
}

/**
 * In-memory dedupe for concurrent first-time renders of the same pull/variant.
 * Per architecture risk 5: if 50 OG link previews arrive at once we want one
 * render, not 50. Same applies inside the indexer when multiple subscriptions
 * fan out to the same channel for the same pull.
 *
 * Key: `${pullId}:${variant}`. Cleared on resolve/reject.
 */
const inFlight = new Map<string, Promise<RenderResult>>();

const pngPathFor = (pullId: string, variant: ShareCardStyleVariant): string =>
  resolve(SHARE_CARD_DIR, `${pullId}-${variant}.png`);

const ensureDirExists = async (path: string): Promise<void> => {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
};

/**
 * Narrow Pull.gradingCompany (string | null) into the grader literal the
 * renderer's `detectStyle` accepts. Anything outside the four known graders
 * collapses to null so detectStyle returns 'generic'.
 */
const normalizeGrader = (
  raw: string | null
): 'PSA' | 'BGS' | 'CGC' | 'SGC' | null => {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (upper === 'PSA' || upper === 'BGS' || upper === 'CGC' || upper === 'SGC') {
    return upper;
  }
  return null;
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
};

/**
 * Render-or-fetch-from-cache. Returns the bytes either way. Inserts a
 * ShareCard row on first render so the OG route (D5) can find the cached PNG
 * by pullId without a re-render.
 *
 * `styleVariant` is optional; when omitted the renderer detects from the
 * Pull's grading company (PSA / BGS / CGC / generic).
 */
export const getOrRenderShareCard = async (
  pullId: string,
  styleVariant?: ShareCardStyleVariant
): Promise<RenderResult> => {
  if (typeof pullId !== 'string' || pullId.length === 0) {
    throw new Error(`${LOG_PREFIX} getOrRenderShareCard requires pullId`);
  }

  // B5: load the Pull ONCE and resolve the variant before building the cache
  // key. The prior key `${pullId}:${styleVariant ?? 'auto'}` produced cache-
  // miss collisions: two concurrent callers, one with `undefined` and one
  // with `psa` for a PSA-graded Pull, would land on different in-flight
  // entries and each pay the render cost. Now the resolved variant is the
  // stable cache key everywhere (in-flight map, DB lookup, render input).
  const pull = await prismaQuery.pull.findFirst({
    where: { id: pullId, deletedAt: null },
  });
  if (pull === null) {
    throw new Error(`${LOG_PREFIX} pull not found id=${pullId}`);
  }

  const resolvedVariant: ShareCardStyleVariant =
    styleVariant ?? detectStyle(normalizeGrader(pull.gradingCompany));

  const cacheKey = `${pullId}:${resolvedVariant}`;
  const existing = inFlight.get(cacheKey);
  if (existing) {
    return existing;
  }

  const work = (async (): Promise<RenderResult> => {
    // 1. Check ShareCard table for a usable cached row at the resolved variant.
    const cachedRow = await prismaQuery.shareCard.findFirst({
      where: {
        pullId,
        deletedAt: null,
        styleVariant: resolvedVariant,
      },
      orderBy: { renderedAt: 'desc' },
    });

    if (cachedRow !== null && (await fileExists(cachedRow.pngPath))) {
      // R8: `readFile` is statically imported at the top of this file; no
      // dynamic import needed.
      const buffer = await readFile(cachedRow.pngPath);
      return {
        pngPath: cachedRow.pngPath,
        buffer,
        byteSize: cachedRow.byteSize ?? buffer.byteLength,
        styleVariant: cachedRow.styleVariant as ShareCardStyleVariant,
      };
    }

    // 2. Cache miss. Build input with the explicit resolved variant so the
    // renderer cannot pick a different one (e.g. on Pulls where gradingCompany
    // was scrubbed between cache-key resolve and renderer execution).
    const input = extractShareCardInputFromPull(pull);
    input.styleVariant = resolvedVariant;

    const rendered = await renderShareCard(input);

    // 3. Persist to disk.
    const pngPath = pngPathFor(pullId, rendered.styleVariant);
    await ensureDirExists(pngPath);
    await writeFile(pngPath, rendered.png);

    // 4. Insert ShareCard row.
    await prismaQuery.shareCard.create({
      data: {
        pullId,
        styleVariant: rendered.styleVariant,
        pngPath,
        widthPx: rendered.widthPx,
        heightPx: rendered.heightPx,
        byteSize: rendered.byteSize,
      },
    });

    console.log(
      `${LOG_PREFIX} cached share-card pull=${pullId} variant=${rendered.styleVariant} bytes=${rendered.byteSize}`
    );

    return {
      pngPath,
      buffer: rendered.png,
      byteSize: rendered.byteSize,
      styleVariant: rendered.styleVariant,
    };
  })();

  inFlight.set(cacheKey, work);
  try {
    return await work;
  } finally {
    inFlight.delete(cacheKey);
  }
};

const formatUsd = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) {
    return 'unknown';
  }
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) {
    return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  return `$${dollars.toFixed(2)}`;
};

/**
 * Renaiss deep-link for a collectible. Best-effort URL; the indexer ships URLs
 * the embed action-row sanitizer will accept (http/https only).
 */
const buildRenaissUrl = (tokenId: string): string =>
  `https://renaiss.xyz/cards/${encodeURIComponent(tokenId)}`;

const buildTweetText = (pull: Pull): string => {
  const card = pull.cardName ?? pull.setName ?? `token #${pull.collectibleTokenId.slice(0, 8)}`;
  const pack = pull.packSlug;
  const price = formatUsd(pull.packPriceUsdCents);
  const fmv = formatUsd(pull.fmvUsdCents);
  return `Just pulled ${card} from ${pack} for ${price} // FMV ${fmv}`;
};

const buildTweetUrl = (pullId: string): string =>
  `https://pullcast.xyz/pull/${encodeURIComponent(pullId)}`;

/**
 * Pull row -> PullEmbedInput. The embed-builder type is local to discord/
 * (Prisma-free) so we copy each field rather than spreading.
 *
 * D8 NOTE (profile enrichment intentionally skipped):
 *   The pull event carries a wallet address (`pull.buyerAddress`), not a
 *   Renaiss UUID. We considered enriching the share-card embed with the
 *   buyer's Renaiss username / avatar via `renaissApi.getUser(uuid)`, but the
 *   public Renaiss main API surface (verified via openapi.json 2026-07-02)
 *   exposes NO address-to-UUID bridge:
 *     - /v0/marketplace lists `ownerAddress` (0x-prefixed hex) and `owner`
 *       (a { username } object with no id).
 *     - /v0/users/{id} requires an RFC 4122 UUID and 404s on wallet-shaped
 *       inputs.
 *     - The frontend does not link to /users/<uuid> pages.
 *   Faking an address-to-UUID resolver would be inventing a bridge that does
 *   not exist. Per `memory/d8-index-max-progress.md` (parallel D8 stream) and
 *   `memory/d8-user-odds-progress.md` (this stream), this is deferred until
 *   either (a) Renaiss ships an address lookup endpoint or (b) PullCast adds
 *   a `subscription.renaissUuid` column populated via a user-confirmed link
 *   flow.
 */
const pullToEmbedInput = (pull: Pull): PullEmbedInput => ({
  id: pull.id,
  packSlug: pull.packSlug,
  cardName: pull.cardName,
  setName: pull.setName,
  cardNumber: pull.cardNumber,
  gradingCompany: pull.gradingCompany,
  grade: pull.grade,
  tier: pull.tier,
  fmvUsdCents: pull.fmvUsdCents,
  packPriceUsdCents: pull.packPriceUsdCents,
  netGainUsdCents: pull.netGainUsdCents,
  frontImageUrl: pull.frontImageUrl,
  buyerAddress: pull.buyerAddress,
  pulledAtTimestamp: pull.pulledAtTimestamp,
});

export interface PostFanoutResult {
  posted: number;
  skipped: number;
  failed: number;
}

/**
 * Fan-out poster. Best-effort; never throws. Returns counters so the caller
 * (indexer) can log a single summary line per pull.
 */
export const postPullToSubscribers = async (pull: Pull): Promise<PostFanoutResult> => {
  const counters: PostFanoutResult = { posted: 0, skipped: 0, failed: 0 };

  let subs: Array<{
    id: string;
    discordChannelId: string;
    packSlug: string | null;
    walletAddress: string | null;
  }>;
  try {
    subs = await prismaQuery.subscription.findMany({
      where: {
        deletedAt: null,
        OR: [{ walletAddress: pull.buyerAddress }, { packSlug: pull.packSlug }],
      },
      select: {
        id: true,
        discordChannelId: true,
        packSlug: true,
        walletAddress: true,
      },
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to load subscriptions pull=${pull.id}:`, err);
    return counters;
  }

  if (subs.length === 0) {
    console.log(`${LOG_PREFIX} no subscribers for pull=${pull.id}`);
    return counters;
  }

  // Render once for the whole fanout.
  let card: RenderResult;
  try {
    card = await getOrRenderShareCard(pull.id);
  } catch (err) {
    console.error(`${LOG_PREFIX} share-card render failed pull=${pull.id}:`, err);
    counters.failed = subs.length;
    return counters;
  }

  const client = getDiscordClient();
  const embedInput = pullToEmbedInput(pull);
  const renaissUrl = buildRenaissUrl(pull.collectibleTokenId);
  const tweetText = buildTweetText(pull);
  const tweetUrl = buildTweetUrl(pull.id);
  const attachmentName = 'share-card.png';

  let postedAtUpdated = false;

  for (const sub of subs) {
    const channelId = sub.discordChannelId;
    try {
      // R3: resolve the channel and check capability BEFORE consuming a rate-
      // limit token. Otherwise a viral pull with N stale subs in the same dead
      // channel eats N tokens (one per sub) before we discover the channel is
      // unusable. Now: dead channel -> soft-delete the sub without consuming.
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel === null) {
        console.warn(
          `${LOG_PREFIX} channel not found, soft-deleting subscription sub=${sub.id} channel=${channelId}`
        );
        await prismaQuery.subscription
          .update({ where: { id: sub.id }, data: { deletedAt: new Date() } })
          .catch((e: unknown) => console.error(`${LOG_PREFIX} soft-delete failed sub=${sub.id}:`, e));
        counters.skipped += 1;
        continue;
      }
      if (!('send' in channel) || typeof channel.send !== 'function' || !channel.isTextBased()) {
        console.warn(
          `${LOG_PREFIX} channel not text-capable, soft-deleting subscription sub=${sub.id} channel=${channelId}`
        );
        await prismaQuery.subscription
          .update({ where: { id: sub.id }, data: { deletedAt: new Date() } })
          .catch((e: unknown) => console.error(`${LOG_PREFIX} soft-delete failed sub=${sub.id}:`, e));
        counters.skipped += 1;
        continue;
      }

      // R3: channel is good, now consume a token. Skipped subs above did not
      // consume; only real attempted sends decrement the bucket.
      const bucketKey = `discord:channel:${channelId}`;
      const allowed = await consumeRateLimitToken(
        bucketKey,
        DISCORD_POST_RATE_PER_CHANNEL_PER_MIN,
        DISCORD_POST_RATE_PER_CHANNEL_PER_MIN
      );
      if (!allowed) {
        console.warn(`${LOG_PREFIX} rate-limited channel=${channelId} sub=${sub.id}`);
        counters.skipped += 1;
        continue;
      }

      // c. Embed
      const embed = buildPullEmbed(embedInput);

      // d. Action row
      const row = buildPullActionRow({ renaissUrl, tweetText, tweetUrl });

      // e. Send
      await channel.send({
        embeds: [embed],
        components: [row],
        files: [{ attachment: card.pngPath, name: attachmentName }],
      });

      console.log(
        `${LOG_PREFIX} posted pull=${pull.id} channel=${channelId} subId=${sub.id}`
      );
      counters.posted += 1;

      // f. Mark Pull.shareCardPostedAt (idempotent; multiple subs same channel re-set).
      if (!postedAtUpdated) {
        await prismaQuery.pull
          .update({ where: { id: pull.id }, data: { shareCardPostedAt: new Date() } })
          .then(() => {
            postedAtUpdated = true;
          })
          .catch((e: unknown) =>
            console.error(`${LOG_PREFIX} failed to set shareCardPostedAt pull=${pull.id}:`, e)
          );
      }
    } catch (err) {
      console.error(
        `${LOG_PREFIX} send failed pull=${pull.id} channel=${channelId} sub=${sub.id}:`,
        err
      );
      counters.failed += 1;
    }
  }

  return counters;
};


/**
 * "Card of the Day" cron worker (D8).
 *
 * Fires at 00:00 UTC+8 daily (16:00 UTC the day before). On tick:
 *
 *   1. Fetch the top-1 mover from `/v1/cards/featured?limit=1`.
 *   2. Render a share-card variant via the existing Satori pipeline using the
 *      new `card-of-the-day` template (gold ribbon header on the base layout).
 *   3. Persist to the `ShareCard` table (dedupe by `card.href` so a re-tick
 *      within the same day does not double-render).
 *   4. For every distinct guild subscription with `type = 'CARD_OF_THE_DAY'`,
 *      post the embed + PNG attachment. If no such subscriptions exist yet,
 *      fall back to the general PULLCAST subscription channels so the debut
 *      still gets delivered somewhere.
 *
 * Notes:
 *  - `isRunning` flag prevents overlapping ticks (per backend CLAUDE.md worker
 *    pattern).
 *  - Wall-clock timeout wrapper mirrors the leaderboard worker so a stalled
 *    Renaiss API / Discord send cannot pile up.
 *  - No boot-time execution: only the schedule fires. A restart mid-day does
 *    not double-post the daily digest.
 *  - `card.href` is the natural dedup key because it uniquely identifies the
 *    grade + card + slab per the Renaiss OS data model.
 *
 * IMPORTANT: this worker adds a synthetic `Pull` row keyed on the Renaiss OS
 * card href so the existing ShareCard schema (which requires a FK to Pull) is
 * satisfied without a schema migration. The pack slug is fixed to
 * `card-of-the-day` so the row is easy to identify + filter out of user pull
 * counts.
 */

import cron from 'node-cron';

import { prismaQuery } from '../lib/prisma.ts';
import { discordEmbedFooter } from '../lib/disclosure/index.ts';
import { getDiscordClient } from '../lib/discord/client.ts';
import {
  buildDisclosureField,
} from '../lib/discord/embed-builders.ts';
import { EmbedBuilder } from 'discord.js';
import {
  renaissIndex,
  hasIndexPartnerAuth,
  IndexApiError,
} from '../lib/renaiss-index/index.ts';
import type { CardSummary } from '../lib/renaiss-index/index.ts';
import { render as renderCardOfTheDay } from '../lib/share-card/templates/card-of-the-day.ts';
import { loadFonts } from '../lib/share-card/fonts.ts';
import { fetchImageAsDataUrl } from '../lib/share-card/render.ts';
import { THEME } from '../lib/share-card/theme.ts';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { DISCORD_POST_RATE_PER_CHANNEL_PER_MIN } from '../config/main-config.ts';
import { consumeRateLimitToken } from '../lib/rate-limit.ts';
import { sanitizeImageUrl } from '../utils/urlAllowlist.ts';

const LOG_PREFIX = '[CardOfTheDay]';

// 00:00 UTC+8 = 16:00 UTC the previous day. node-cron accepts a `timezone`
// option so we can express the schedule in the intended zone directly and let
// the scheduler handle DST rules.
const CRON_SCHEDULE = '0 0 * * *' as const;
const CRON_TIMEZONE = 'Asia/Hong_Kong' as const;
const TICK_TIMEOUT_MS = 90_000; // render + fetch + fanout can take a while

const SHARE_CARD_DIR = resolve(process.cwd(), 'tmp', 'share-cards');
const COTD_PACK_SLUG = '__card-of-the-day__';

let isRunning = false;

const withTimeout = async <T>(p: Promise<T>, ms: number, tag: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${LOG_PREFIX} ${tag} exceeded ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};

const ensureDirExists = async (path: string): Promise<void> => {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
};

const normalizeGrader = (
  company: CardSummary['company']
): 'PSA' | 'BGS' | 'CGC' | 'SGC' | null => {
  if (company === 'PSA' || company === 'BGS' || company === 'CGC' || company === 'SGC') {
    return company;
  }
  return null;
};

/**
 * Render a Card of the Day PNG from a CardSummary. Returns { pngPath, byteSize }.
 * Uses the same Satori + Resvg pipeline as regular share-card renders so we
 * stay within one code path for OG parity.
 */
const renderCardOfTheDayPng = async (
  card: CardSummary
): Promise<{ pngPath: string; byteSize: number }> => {
  const fonts = await loadFonts();
  const imageSrc = await fetchImageAsDataUrl(card.imageUrl ?? '');

  const input = {
    cardName: card.name,
    setName: card.setName ?? undefined,
    cardNumber: card.cardNumber ?? undefined,
    imageUrl: card.imageUrl ?? '',
    packLabel: 'Card of the Day',
    packPriceUsdCents: 0,
    fmvUsdCents: card.priceUsdCents ?? null,
    netGainUsdCents: null,
    gradingCompany: normalizeGrader(card.company),
    grade: card.gradeLabel,
    serial: null,
    buyerAddress: '',
    pulledAt: new Date(),
    tier: null,
    styleVariant: 'generic' as const,
  };

  const element = renderCardOfTheDay(input, imageSrc) as unknown as Parameters<
    typeof satori
  >[0];

  const svg = await satori(element, {
    width: THEME.canvas.width,
    height: THEME.canvas.height,
    fonts: fonts.map((f) => ({
      name: f.name,
      data: f.data,
      weight: f.weight,
      style: f.style,
    })),
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: THEME.canvas.width },
    font: { loadSystemFonts: false },
  });
  const png = Buffer.from(resvg.render().asPng());

  // File name is deterministic per href so a same-day re-tick reuses the same
  // PNG on disk. `href` may contain slashes; sanitize to a filename-safe slug.
  const slug = card.href.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
  const pngPath = resolve(SHARE_CARD_DIR, `cotd-${slug}.png`);
  await ensureDirExists(pngPath);
  await writeFile(pngPath, png);

  return { pngPath, byteSize: png.byteLength };
};

/**
 * Upsert a synthetic Pull row for the given Card of the Day so the ShareCard
 * table's FK invariant holds without extending the schema. We use the card's
 * href as the natural key (mapped into `collectibleTokenId` since that is the
 * dedupe column on the existing @@unique). Idempotent: same href on the same
 * day is a no-op.
 */
const upsertCardOfTheDayPull = async (card: CardSummary): Promise<string> => {
  const now = new Date();
  const existing = await prismaQuery.pull.findFirst({
    where: {
      packSlug: COTD_PACK_SLUG,
      collectibleTokenId: card.href,
    },
    select: { id: true },
  });
  if (existing !== null) return existing.id;

  // D8-M-6: apply the same SSRF allowlist the indexer uses so downstream
  // consumers of `Pull.frontImageUrl` (share-card renderer, `<img>` tags on
  // the frontend, future `/og/:pullId` variants) cannot be redirected at
  // internal IPs by a compromised Renaiss API response. `sanitizeImageUrl`
  // returns null on any URL that is not an https: request to an allowlisted
  // Renaiss host; the DB then stores null and downstream renders fall back
  // to a placeholder.
  const safeFrontImageUrl = sanitizeImageUrl(card.imageUrl);
  if (safeFrontImageUrl === null && typeof card.imageUrl === 'string' && card.imageUrl.length > 0) {
    console.warn(
      `${LOG_PREFIX} rejected non-allowlisted imageUrl for card of the day, persisting null href=${card.href}`
    );
  }
  const created = await prismaQuery.pull.create({
    data: {
      packSlug: COTD_PACK_SLUG,
      collectibleTokenId: card.href,
      buyerAddress: '0x0000000000000000000000000000000000000000',
      tier: null,
      fmvUsdCents: card.priceUsdCents ?? null,
      packPriceUsdCents: 0,
      netGainUsdCents: null,
      pulledAtTimestamp: now,
      cardName: card.name,
      setName: card.setName,
      cardNumber: card.cardNumber,
      gradingCompany: normalizeGrader(card.company),
      grade: card.gradeLabel,
      serial: null,
      frontImageUrl: safeFrontImageUrl,
      backImageUrl: null,
    },
  });
  return created.id;
};

const buildCotdEmbed = (card: CardSummary): EmbedBuilder => {
  const priceCents = card.priceUsdCents ?? null;
  const priceText =
    priceCents !== null
      ? `$${(priceCents / 100).toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`
      : '–';
  const deltaText =
    typeof card.deltaPct === 'number' && Number.isFinite(card.deltaPct)
      ? `${card.deltaPct >= 0 ? '▲' : '▼'} ${card.deltaPct >= 0 ? '+' : ''}${card.deltaPct.toFixed(2)}%`
      : '–';
  const embed = new EmbedBuilder()
    .setTitle(`Card of the Day: ${card.name}`)
    .setColor(0xf4c542)
    .setDescription(
      [card.setName, card.cardNumber ? `#${card.cardNumber}` : null, card.gradeLabel]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('  ·  ')
    )
    .addFields(
      { name: 'Price', value: priceText, inline: true },
      { name: '7d delta', value: deltaText, inline: true },
      { name: 'Confidence', value: card.confidence ?? 'unknown', inline: true },
      buildDisclosureField()
    )
    .setFooter(discordEmbedFooter());

  return embed;
};

/**
 * Load the fanout target channels. Prefer `type = CARD_OF_THE_DAY` subscribers;
 * if there are none, fall back to the general PULLCAST subscriptions so the
 * debut day still lands somewhere. Distinct on discordChannelId to avoid
 * double-posting to a channel with multiple overlapping subscriptions.
 */
const loadFanoutChannels = async (): Promise<string[]> => {
  const cotd = await prismaQuery.subscription.findMany({
    where: { deletedAt: null, type: 'CARD_OF_THE_DAY' },
    select: { discordChannelId: true },
    distinct: ['discordChannelId'],
  });
  if (cotd.length > 0) {
    return cotd.map((r: { discordChannelId: string }) => r.discordChannelId);
  }

  console.log(
    `${LOG_PREFIX} no CARD_OF_THE_DAY subs, falling back to PULLCAST subscribers`
  );
  const fallback = await prismaQuery.subscription.findMany({
    where: { deletedAt: null, type: 'PULLCAST' },
    select: { discordChannelId: true },
    distinct: ['discordChannelId'],
  });
  return fallback.map((r: { discordChannelId: string }) => r.discordChannelId);
};

const runOnce = async (): Promise<void> => {
  if (!hasIndexPartnerAuth()) {
    console.log(`${LOG_PREFIX} tick skipped: no partner API credentials`);
    return;
  }

  console.log(`${LOG_PREFIX} tick start`);

  let cards: CardSummary[];
  try {
    cards = await renaissIndex.getFeatured(1);
  } catch (err) {
    if (err instanceof IndexApiError) {
      console.warn(
        `${LOG_PREFIX} featured fetch failed status=${err.status}, aborting tick`
      );
    } else {
      console.error(`${LOG_PREFIX} featured fetch unexpected error:`, err);
    }
    return;
  }

  if (cards.length === 0) {
    console.log(`${LOG_PREFIX} featured returned zero cards, nothing to post`);
    return;
  }

  const top = cards[0];

  // Dedupe by href across ShareCard rows: if we already have a card-of-the-day
  // ShareCard for this href we skip the render and reuse the PNG on disk.
  let pullId: string;
  try {
    pullId = await upsertCardOfTheDayPull(top);
  } catch (err) {
    console.error(`${LOG_PREFIX} pull upsert failed href=${top.href}:`, err);
    return;
  }

  const existingCard = await prismaQuery.shareCard
    .findFirst({
      where: { pullId, styleVariant: 'card-of-the-day', deletedAt: null },
      orderBy: { renderedAt: 'desc' },
    })
    .catch(() => null);

  let pngPath: string;
  let byteSize: number;

  if (existingCard !== null) {
    pngPath = existingCard.pngPath;
    byteSize = existingCard.byteSize ?? 0;
    console.log(
      `${LOG_PREFIX} reusing cached ShareCard href=${top.href} path=${pngPath}`
    );
  } else {
    try {
      const rendered = await renderCardOfTheDayPng(top);
      pngPath = rendered.pngPath;
      byteSize = rendered.byteSize;
      await prismaQuery.shareCard.create({
        data: {
          pullId,
          styleVariant: 'card-of-the-day',
          pngPath,
          widthPx: THEME.canvas.width,
          heightPx: THEME.canvas.height,
          byteSize,
        },
      });
      console.log(
        `${LOG_PREFIX} rendered ShareCard href=${top.href} bytes=${byteSize}`
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} render failed href=${top.href}:`, err);
      return;
    }
  }

  const channels = await loadFanoutChannels().catch((err: unknown) => {
    console.error(`${LOG_PREFIX} fanout channels lookup failed:`, err);
    return [] as string[];
  });

  if (channels.length === 0) {
    console.log(`${LOG_PREFIX} no fanout channels, skipping post`);
    return;
  }

  const client = getDiscordClient();
  if (!client.isReady()) {
    console.warn(
      `${LOG_PREFIX} discord not ready, skipping fanout (${channels.length} channels)`
    );
    return;
  }

  const embed = buildCotdEmbed(top);
  let posted = 0;
  let skipped = 0;
  let failed = 0;

  for (const channelId of channels) {
    if (typeof channelId !== 'string' || channelId.length === 0) {
      skipped += 1;
      continue;
    }
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (
        channel === null ||
        !('send' in channel) ||
        typeof channel.send !== 'function' ||
        !channel.isTextBased()
      ) {
        console.warn(
          `${LOG_PREFIX} channel not usable, soft-deleting subs channel=${channelId}`
        );
        await prismaQuery.subscription
          .updateMany({
            where: { discordChannelId: channelId, deletedAt: null },
            data: { deletedAt: new Date() },
          })
          .catch((e: unknown) =>
            console.error(
              `${LOG_PREFIX} soft-delete failed channel=${channelId}:`,
              e
            )
          );
        skipped += 1;
        continue;
      }

      const allowed = await consumeRateLimitToken(
        `discord:channel:${channelId}`,
        DISCORD_POST_RATE_PER_CHANNEL_PER_MIN,
        DISCORD_POST_RATE_PER_CHANNEL_PER_MIN
      );
      if (!allowed) {
        console.warn(`${LOG_PREFIX} rate-limited channel=${channelId}`);
        skipped += 1;
        continue;
      }

      await channel.send({
        embeds: [embed],
        files: [{ attachment: pngPath, name: 'card-of-the-day.png' }],
      });
      posted += 1;
      console.log(`${LOG_PREFIX} posted channel=${channelId} href=${top.href}`);
    } catch (err) {
      console.error(
        `${LOG_PREFIX} send failed channel=${channelId} href=${top.href}:`,
        err
      );
      failed += 1;
    }
  }

  console.log(
    `${LOG_PREFIX} tick done posted=${posted} skipped=${skipped} failed=${failed} href=${top.href}`
  );
};

const tick = async (): Promise<void> => {
  if (isRunning) {
    console.log(`${LOG_PREFIX} previous tick still running, skipping`);
    return;
  }
  isRunning = true;
  try {
    await withTimeout(runOnce(), TICK_TIMEOUT_MS, 'runOnce');
  } catch (err) {
    console.error(`${LOG_PREFIX} tick failed:`, err);
  } finally {
    isRunning = false;
  }
};

export const startCardOfTheDayWorker = (): void => {
  console.log(
    `${LOG_PREFIX} Scheduled schedule="${CRON_SCHEDULE}" tz=${CRON_TIMEZONE}`
  );
  cron.schedule(
    CRON_SCHEDULE,
    () => {
      void tick();
    },
    { timezone: CRON_TIMEZONE }
  );
};

// Exported for tests / manual triggers.
export const _tickForTest = tick;

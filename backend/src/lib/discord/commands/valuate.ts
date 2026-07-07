/**
 * `/valuate` slash command group (D6 M1 + M9).
 *
 * Subcommands:
 *   /valuate cert   cert:PSA73628064    - streams cert pipeline progress,
 *                                          falls back to cached sync on 5xx
 *   /valuate photo  image:<attachment>  - uploads photo, streams progress by
 *                                          editing the reply every ~2s per stage
 *
 * Both subcommands defer the reply and update it on each pipeline stage so the
 * user sees a live progress bar. Terminal frame renders a price embed.
 *
 * Hard rules honored:
 *  - All embeds go through the shared builders (footer + disclosure field are
 *    guaranteed by the builders themselves).
 *  - Index API cert path goes through `streamCertWithFallback` -> either the
 *    SSE endpoint or the cached sync `getOrFetchCert` on repeated 5xx.
 *  - Per-user rate limit via the atomic `consumeRateLimitToken` bucket
 *    `discord:command:valuate:<userId>` (3 tokens / 3 per minute refill —
 *    photo pipelines are expensive, so tighter than /price).
 */

import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import type { Command } from '../command-registry.ts';
import {
  buildDisclosureField,
  buildErrorEmbed,
  buildIndexRateLimitedEmbed,
  buildPriceEmbed,
  type PriceLookupResult,
} from '../embed-builders.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';
import { streamCertWithFallback } from '../../renaiss-index/cert-stream.ts';
import {
  PHOTO_ALLOWED_MIME_TYPES,
  PHOTO_MAX_BYTES,
  isAllowedPhotoMime,
  valuateByImage,
} from '../../renaiss-index/photo.ts';
import type { PipelineProgress } from '../../renaiss-index/sse.ts';
import type { IndexGraded } from '../../renaiss-index/types.ts';
import { parsePriceCents } from '../../renaiss/types.ts';
import { IndexApiError } from '../../renaiss-index/index.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';
import { buildReportMissingCoverageCustomId } from './report.ts';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const LOG_PREFIX = '[valuate]';

const CERT_RX = /^(PSA|BGS|CGC|SGC)\d{6,12}$/i;

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const STAGE_ORDER: PipelineProgress['stage'][] = [
  'cert_lookup',
  'identify',
  'enrich',
  'find_item',
  'cache_check',
  'match',
  'crawl',
  'fmv',
  'done',
];

const PROGRESS_EDIT_MIN_MS = 2000;

const stageIndex = (stage: PipelineProgress['stage']): number => {
  const idx = STAGE_ORDER.indexOf(stage);
  return idx === -1 ? 0 : idx;
};

const buildProgressEmbed = (
  label: string,
  progress: PipelineProgress | null
): EmbedBuilder => {
  const step = progress ? stageIndex(progress.stage) + 1 : 0;
  const total = STAGE_ORDER.length;
  const barLen = 12;
  const filled = Math.round((step / total) * barLen);
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
  const stageLabel = progress
    ? `Stage ${step}/${total}: ${progress.stage}`
    : 'Starting pipeline...';
  const description = [
    `**${label}**`,
    `\`${bar}\` ${Math.round((step / total) * 100)}%`,
    stageLabel,
    progress?.message ? `_${progress.message}_` : '',
  ]
    .filter((s) => s.length > 0)
    .join('\n');

  return new EmbedBuilder()
    .setTitle('Valuating...')
    .setColor(0x3498db)
    .setDescription(description)
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());
};

/**
 * Convert an IndexGraded payload into the shared PriceLookupResult contract
 * so we can reuse the existing /price embed builder.
 */
const buildResultFromGraded = (
  graded: IndexGraded,
  labelKey: string
): PriceLookupResult => {
  const card = graded.card ?? {};
  const indexCents = parsePriceCents(
    (card as { priceUsdCents?: number | null }).priceUsdCents ?? null
  );
  const stringOrNull = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

  let lastSaleAt: Date | null = null;
  if (typeof card.lastSaleAt === 'string' && card.lastSaleAt.length > 0) {
    const d = new Date(card.lastSaleAt);
    if (!Number.isNaN(d.getTime())) lastSaleAt = d;
  }

  const imageUrl =
    stringOrNull((card as { imageUrl?: string }).imageUrl) ??
    stringOrNull(graded.certImages?.front) ??
    null;

  return {
    tokenIdOrCert: labelKey,
    cardName: stringOrNull(card.name),
    setName: stringOrNull(card.setName),
    grade: stringOrNull(card.grade),
    mainApiFmvCents: null,
    indexApiFmvCents: indexCents,
    recommendedFmvCents: indexCents,
    confidence: (card.confidence ?? null) as 'prime' | 'high' | 'medium' | 'low' | null,
    lastSaleAt,
    imageUrl,
    sources: [
      {
        name: 'Renaiss OS Index (beta)',
        url: 'https://api.renaissos.com/v1',
      },
    ],
  };
};

/**
 * Throttled progress updater. Guarantees at least `PROGRESS_EDIT_MIN_MS` ms
 * between edits (Discord rate-limits editReply at ~5/5s per interaction).
 */
class ProgressThrottler {
  private lastEditAt = 0;
  private pending: PipelineProgress | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private ended = false;

  constructor(
    private readonly interaction: ChatInputCommandInteraction,
    private readonly label: string
  ) {}

  onProgress(progress: PipelineProgress): void {
    if (this.ended) return;
    this.pending = progress;
    const now = Date.now();
    const elapsed = now - this.lastEditAt;
    if (elapsed >= PROGRESS_EDIT_MIN_MS) {
      void this.flush();
    } else if (this.flushTimer === null) {
      const wait = Math.max(0, PROGRESS_EDIT_MIN_MS - elapsed);
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, wait);
    }
  }

  private async flush(): Promise<void> {
    if (this.ended || this.pending === null) return;
    const p = this.pending;
    this.pending = null;
    this.lastEditAt = Date.now();
    try {
      await this.interaction.editReply({
        embeds: [buildProgressEmbed(this.label, p)],
      });
    } catch (err) {
      // Interaction expired or was dismissed. Stop trying.
      console.warn(`${LOG_PREFIX} progress editReply failed:`, err);
      this.ended = true;
    }
  }

  end(): void {
    this.ended = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// /valuate cert cert:<cert>
// ---------------------------------------------------------------------------

const handleCert = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const certRaw = interaction.options.getString('cert', true);
  const certInput = certRaw.trim();

  if (!CERT_RX.test(certInput)) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          'Cert format must be PSA/BGS/CGC/SGC followed by 6-12 digits (e.g. PSA73628064).'
        ),
      ],
    });
    return;
  }

  const cert = certInput.toUpperCase();
  const throttler = new ProgressThrottler(interaction, `Cert ${cert}`);
  // Show an immediate placeholder so the user sees action right away.
  try {
    await interaction.editReply({
      embeds: [buildProgressEmbed(`Cert ${cert}`, null)],
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} initial cert placeholder edit failed:`, err);
  }

  let lookup;
  try {
    lookup = await streamCertWithFallback(cert, (p) => throttler.onProgress(p));
  } catch (err) {
    throttler.end();
    if (err instanceof IndexApiError) {
      console.warn(`${LOG_PREFIX} cert lookup failed cert=${cert} status=${err.status}`);
      if (err.status === 429) {
        await interaction.editReply({
          embeds: [buildIndexRateLimitedEmbed()],
        });
        return;
      }
    } else {
      console.error(`${LOG_PREFIX} cert lookup unexpected cert=${cert}:`, err);
    }
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          `Renaiss Index API unreachable for ${cert}. Please try again in a moment.`
        ),
      ],
    });
    return;
  }
  throttler.end();

  if (!lookup.result.found) {
    // M8: offer a "Report missing coverage" button so the user can nudge
    // Renaiss to expand coverage. The button opens the same modal as the
    // /report slash command, pre-populated with this cert.
    const reportButton = new ButtonBuilder()
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Report missing coverage')
      .setCustomId(buildReportMissingCoverageCustomId('cert', cert));
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(reportButton);
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          `No grading record found for ${cert}. Try /valuate photo image:<slab.jpg> if you have a picture, or report the missing coverage below.`
        ),
      ],
      components: [row],
    });
    return;
  }

  const embed = buildPriceEmbed(buildResultFromGraded(lookup.result, cert));
  await interaction.editReply({ embeds: [embed] });
  console.log(
    `${LOG_PREFIX} cert ok user=${interaction.user.id} cert=${cert} streamed=${lookup.streamed}`
  );
};

// ---------------------------------------------------------------------------
// /valuate photo image:<attachment>
// ---------------------------------------------------------------------------

const handlePhoto = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const attachment = interaction.options.getAttachment('image', true);

  if (typeof attachment.size === 'number' && attachment.size > PHOTO_MAX_BYTES) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          `Image is ${(attachment.size / 1024 / 1024).toFixed(2)} MB; the ${(PHOTO_MAX_BYTES / 1024 / 1024).toFixed(0)} MB limit means it will not fit. Try a smaller crop.`
        ),
      ],
    });
    return;
  }
  const mime =
    typeof attachment.contentType === 'string' ? attachment.contentType : '';
  const baseMime = mime.split(';')[0].trim();
  if (!isAllowedPhotoMime(baseMime)) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          `Unsupported image type: ${baseMime || 'unknown'}. Allowed: ${PHOTO_ALLOWED_MIME_TYPES.join(', ')}.`
        ),
      ],
    });
    return;
  }
  if (typeof attachment.url !== 'string' || !attachment.url.startsWith('https://')) {
    await interaction.editReply({
      embeds: [buildErrorEmbed('Discord attachment URL was not HTTPS.')],
    });
    return;
  }

  const label = `Photo ${attachment.name ?? 'upload'}`;
  const throttler = new ProgressThrottler(interaction, label);
  try {
    await interaction.editReply({
      embeds: [buildProgressEmbed(label, null)],
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} initial photo placeholder edit failed:`, err);
  }

  // Fetch the Discord CDN image with a short ceiling. Bounded so we cannot
  // block the interaction for the entire 15-minute discord token lifetime.
  let buffer: Buffer;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(attachment.url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Discord CDN returned ${res.status}`);
      }
      const contentLen = res.headers.get('content-length');
      if (contentLen !== null) {
        const n = Number(contentLen);
        if (Number.isFinite(n) && n > PHOTO_MAX_BYTES) {
          throw new Error(`Image is ${n} bytes; exceeds ${PHOTO_MAX_BYTES}`);
        }
      }
      const arr = await res.arrayBuffer();
      if (arr.byteLength > PHOTO_MAX_BYTES) {
        throw new Error(`Image is ${arr.byteLength} bytes; exceeds ${PHOTO_MAX_BYTES}`);
      }
      buffer = Buffer.from(arr);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    throttler.end();
    console.warn(`${LOG_PREFIX} attachment fetch failed:`, err);
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          'Could not download the image from Discord. Try again in a moment.'
        ),
      ],
    });
    return;
  }

  let result: IndexGraded;
  try {
    result = await valuateByImage(
      buffer,
      attachment.name ?? 'upload.jpg',
      baseMime,
      {
        onProgress: (p) => throttler.onProgress(p),
      }
    );
  } catch (err) {
    throttler.end();
    if (err instanceof IndexApiError) {
      console.warn(`${LOG_PREFIX} photo pipeline failed:`, err.message);
      if (err.status === 429) {
        await interaction.editReply({
          embeds: [buildIndexRateLimitedEmbed()],
        });
        return;
      }
    } else {
      console.error(`${LOG_PREFIX} photo pipeline unexpected:`, err);
    }
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          'The image could not be valuated. It may not be a readable card or the pipeline is busy. Try again in a moment.'
        ),
      ],
    });
    return;
  }
  throttler.end();

  const label2 = result.certNumber ?? result.cert ?? attachment.name ?? 'Photo';
  if (!result.found) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          `We could read the card but no matching grading record was found${result.reason ? ` (${result.reason})` : ''}.`
        ),
      ],
    });
    return;
  }

  const embed = buildPriceEmbed(buildResultFromGraded(result, String(label2)));
  await interaction.editReply({ embeds: [embed] });
  console.log(
    `${LOG_PREFIX} photo ok user=${interaction.user.id} cert=${result.cert} bytes=${buffer.length}`
  );
};

// ---------------------------------------------------------------------------
// Per-user rate limit + dispatch
// ---------------------------------------------------------------------------

const consumeValuateToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:valuate:${userId}`, 3, 3);
};

const data = new SlashCommandBuilder()
  .setName('valuate')
  .setDescription('Value a graded card by cert number or by uploading a photo.')
  .addSubcommand((sc) =>
    sc
      .setName('cert')
      .setDescription('Value by graded slab cert (PSA / BGS / CGC / SGC).')
      .addStringOption((opt) =>
        opt
          .setName('cert')
          .setDescription('Cert serial, e.g. PSA73628064.')
          .setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName('photo')
      .setDescription('Value by uploading a slab / card photo (<=15 MB).')
      .addAttachmentOption((opt) =>
        opt
          .setName('image')
          .setDescription('JPEG / PNG / WebP / AVIF / HEIC (<=15 MB).')
          .setRequired(true)
      )
  );

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  // Rate-limit BEFORE deferring so an exhausted user does not consume a
  // deferred reply slot.
  const allowed = await consumeValuateToken(interaction.user.id);
  if (!allowed) {
    const slowEmbed = new EmbedBuilder()
      .setTitle('Slow down please')
      .setColor(0xe67e22)
      .setDescription(
        'You have hit the /valuate rate limit (3 per minute). Photo pipelines are expensive; please try again shortly.'
      )
      .addFields(buildDisclosureField())
      .setFooter(discordEmbedFooter());
    await interaction.reply({ embeds: [slowEmbed], ...ephemeral });
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error(`${LOG_PREFIX} deferReply failed:`, err);
    return;
  }

  const sub = interaction.options.getSubcommand();
  try {
    switch (sub) {
      case 'cert':
        await handleCert(interaction);
        return;
      case 'photo':
        await handlePhoto(interaction);
        return;
      default:
        await interaction.editReply({
          embeds: [buildErrorEmbed(`Unknown subcommand: ${sub}`)],
        });
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} handler unexpected error sub=${sub}:`, err);
    try {
      await interaction.editReply({
        embeds: [
          buildErrorEmbed('Something went wrong. Please try again in a moment.'),
        ],
      });
    } catch (replyErr) {
      console.error(`${LOG_PREFIX} editReply failed:`, replyErr);
    }
  }
};

export const valuateCommand: Command = { data, handler };

/**
 * `/price` slash command group.
 *
 * Subcommands:
 *  - token  - look up Renaiss Registry V3 tokenId. Calls main API + (when a
 *             serial is present) Index API via the cert-cache helper to surface
 *             both FMV signals side-by-side.
 *  - cert   - look up a graded slab cert directly via the Index API cache.
 *
 * Both subcommands defer the reply because upstream calls can take 200ms-3s.
 *
 * Hard rules honored:
 *  - All embeds go through `buildPriceEmbed` / `buildErrorEmbed` so the
 *    disclosure footer + spacer field are present on every output.
 *  - Index API access goes through `getOrFetchCert` (the cache layer), never
 *    `renaissIndex.getGradedByCert` directly.
 *  - Per-user rate-limit via the atomic `consumeRateLimitToken` bucket
 *    `discord:command:price:<userId>` (5 tokens / 5 per minute refill).
 */

import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import type { Command } from '../command-registry.ts';
import {
  buildErrorEmbed,
  buildIndexRateLimitedEmbed,
  buildPriceEmbed,
  type PriceLookupResult,
} from '../embed-builders.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';
import { buildDisclosureField } from '../embed-builders.ts';
import { renaissApi, parsePriceCents, RenaissApiError } from '../../renaiss/index.ts';
import { getOrFetchCert, IndexApiError } from '../../renaiss-index/index.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';

const LOG_PREFIX = '[price]';

const CERT_RX = /^(PSA|BGS|CGC|SGC)\d{6,12}$/i;
const TOKEN_RX = /^[0-9]{1,78}$/;

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

interface NormalizedCard {
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  gradingCompany: string | null;
  grade: string | null;
  serial: string | null;
  imageUrl: string | null;
  attributes: unknown;
}

/**
 * Pluck the fields we care about out of a Renaiss main API card response. The
 * client returns a passthrough zod object so this dives in defensively.
 */
const normalizeRenaissCard = (raw: unknown): NormalizedCard => {
  const card = (raw ?? {}) as Record<string, unknown>;
  const stringOrNull = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

  let serial: string | null = stringOrNull(card.serial);
  let gradingCompany: string | null = stringOrNull(card.gradingCompany);
  let grade: string | null = stringOrNull(card.grade);
  const attrs = card.attributes;

  if (Array.isArray(attrs)) {
    for (const a of attrs) {
      if (typeof a !== 'object' || a === null) continue;
      const t = (a as { trait_type?: unknown }).trait_type;
      const v = (a as { value?: unknown }).value;
      if (typeof t !== 'string') continue;
      const traitLower = t.toLowerCase();
      const valStr =
        typeof v === 'string' && v.length > 0
          ? v
          : typeof v === 'number' && Number.isFinite(v)
            ? String(v)
            : null;
      if (valStr === null) continue;
      if (
        serial === null &&
        (traitLower === 'serial' ||
          traitLower === 'cert' ||
          traitLower === 'cert number' ||
          traitLower === 'certification')
      ) {
        serial = valStr;
      } else if (
        gradingCompany === null &&
        (traitLower === 'grading company' || traitLower === 'grader')
      ) {
        gradingCompany = valStr;
      } else if (grade === null && traitLower === 'grade') {
        grade = valStr;
      }
    }
  }

  return {
    cardName: stringOrNull(card.name),
    setName: stringOrNull(card.setName),
    cardNumber: stringOrNull(card.cardNumber),
    gradingCompany,
    grade,
    serial,
    imageUrl: stringOrNull(card.imageUrl),
    attributes: attrs,
  };
};

/**
 * Blend the two FMV signals. Prefer the Index API value when both exist (it is
 * the graded-slab authority per file 17). Otherwise use whichever is non-null.
 */
const recommendedFmv = (
  mainCents: number | null,
  indexCents: number | null
): number | null => {
  if (indexCents !== null) return indexCents;
  if (mainCents !== null) return mainCents;
  return null;
};

/**
 * Variance check used to surface a "FMV variance high" warning when both
 * sources disagree by > 20%.
 */
const variancePct = (a: number, b: number): number => {
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return Math.abs(a - b) / denom;
};

/**
 * Append a variance warning line to the embed description when both FMV
 * signals are present and disagree by > 20%.
 */
const appendVarianceLine = (
  embed: EmbedBuilder,
  mainCents: number | null,
  indexCents: number | null
): void => {
  if (mainCents === null || indexCents === null) return;
  const pct = variancePct(mainCents, indexCents);
  if (pct <= 0.2) return;
  const existing = embed.data.description ?? '';
  const sep = existing.length > 0 ? '\n' : '';
  embed.setDescription(
    `${existing}${sep}FMV variance high (${Math.round(pct * 100)}%); see sources.`
  );
};

/**
 * Append a "no graded cert linked" footnote when the Renaiss token has no
 * serial in its attributes.
 */
const appendNoCertLine = (embed: EmbedBuilder): void => {
  const existing = embed.data.description ?? '';
  const sep = existing.length > 0 ? '\n' : '';
  embed.setDescription(
    `${existing}${sep}No graded cert linked to this token. Showing Renaiss main API FMV only.`
  );
};

// ---------------------------------------------------------------------------
// /price token <tokenId>
// ---------------------------------------------------------------------------

const handleToken = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const tokenIdRaw = interaction.options.getString('tokenid', true);
  const tokenId = tokenIdRaw.trim();

  if (!TOKEN_RX.test(tokenId)) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          'TokenId must be a decimal integer (up to 78 digits, uint256 safe).'
        ),
      ],
    });
    return;
  }

  let card;
  try {
    card = await renaissApi.getCard(tokenId);
  } catch (err) {
    if (err instanceof RenaissApiError) {
      console.warn(`${LOG_PREFIX} getCard failed token=${tokenId} status=${err.status}`);
    } else {
      console.error(`${LOG_PREFIX} getCard unexpected token=${tokenId}:`, err);
    }
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          `Token ${tokenId} not found or Renaiss API unreachable.`
        ),
      ],
    });
    return;
  }

  const normalized = normalizeRenaissCard(card);
  const mainCents = parsePriceCents(
    (card as { fmvPriceInUSD?: unknown }).fmvPriceInUSD as
      | string
      | number
      | null
      | undefined
  );

  let indexCents: number | null = null;
  let confidence: 'prime' | 'high' | 'medium' | 'low' | null = null;
  let lastSaleAt: Date | null = null;
  const sources: Array<{ name: string; url: string }> = [
    {
      name: 'Renaiss main API',
      url: `https://api.renaiss.xyz/v0/collectibles/${encodeURIComponent(tokenId)}`,
    },
  ];

  let serialUsed = false;
  if (normalized.serial !== null) {
    try {
      const cert = await getOrFetchCert(normalized.serial.toUpperCase());
      if (cert.found && cert.card) {
        indexCents = parsePriceCents(cert.card.priceUsdCents ?? null);
        confidence = (cert.card.confidence ?? null) as
          | 'high'
          | 'medium'
          | 'low'
          | null;
        const sale = cert.card.lastSaleAt;
        if (typeof sale === 'string' && sale.length > 0) {
          const d = new Date(sale);
          if (!Number.isNaN(d.getTime())) lastSaleAt = d;
        }
        sources.push({
          name: 'Renaiss Index API',
          url: `https://api.renaissos.com/v1/graded/${encodeURIComponent(normalized.serial.toUpperCase())}`,
        });
        serialUsed = true;
      }
    } catch (err) {
      if (err instanceof IndexApiError) {
        console.warn(
          `${LOG_PREFIX} Index API lookup failed serial=${normalized.serial} status=${err.status}`
        );
      } else {
        console.error(
          `${LOG_PREFIX} Index API lookup unexpected serial=${normalized.serial}:`,
          err
        );
      }
      // Silent fallback - we still have main API data.
    }
  }

  const result: PriceLookupResult = {
    tokenIdOrCert: tokenId,
    cardName: normalized.cardName,
    setName: normalized.setName,
    grade: normalized.grade,
    mainApiFmvCents: mainCents,
    indexApiFmvCents: indexCents,
    recommendedFmvCents: recommendedFmv(mainCents, indexCents),
    confidence,
    lastSaleAt,
    imageUrl: normalized.imageUrl,
    sources,
  };

  const embed = buildPriceEmbed(result);
  if (normalized.serial === null) {
    appendNoCertLine(embed);
  } else if (!serialUsed) {
    // Serial present but Index API had no record / unreachable.
    const existing = embed.data.description ?? '';
    const sep = existing.length > 0 ? '\n' : '';
    embed.setDescription(
      `${existing}${sep}Graded record not available right now; showing main API FMV.`
    );
  }
  appendVarianceLine(embed, mainCents, indexCents);

  await interaction.editReply({ embeds: [embed] });
  console.log(
    `${LOG_PREFIX} token ok user=${interaction.user.id} token=${tokenId} mainCents=${mainCents} indexCents=${indexCents}`
  );
};

// ---------------------------------------------------------------------------
// /price cert <cert>
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

  let lookup;
  try {
    lookup = await getOrFetchCert(cert);
  } catch (err) {
    if (err instanceof IndexApiError) {
      console.warn(
        `${LOG_PREFIX} cert lookup failed cert=${cert} status=${err.status}`
      );
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

  if (!lookup.found) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          `No grading record found for ${cert}. Try /price token <id> if you have the Renaiss tokenId.`
        ),
      ],
    });
    return;
  }

  const cardPayload = lookup.card ?? {};
  const indexCents = parsePriceCents(
    (cardPayload as { priceUsdCents?: number | null }).priceUsdCents ?? null
  );
  const cardName =
    typeof cardPayload.name === 'string' && cardPayload.name.length > 0
      ? cardPayload.name
      : null;
  const setName =
    typeof cardPayload.setName === 'string' && cardPayload.setName.length > 0
      ? cardPayload.setName
      : null;
  const grade =
    typeof cardPayload.grade === 'string' && cardPayload.grade.length > 0
      ? cardPayload.grade
      : null;
  const imageUrl =
    typeof cardPayload.imageUrl === 'string' && cardPayload.imageUrl.length > 0
      ? cardPayload.imageUrl
      : null;
  let lastSaleAt: Date | null = null;
  if (typeof cardPayload.lastSaleAt === 'string' && cardPayload.lastSaleAt.length > 0) {
    const d = new Date(cardPayload.lastSaleAt);
    if (!Number.isNaN(d.getTime())) lastSaleAt = d;
  }
  const confidence = (cardPayload.confidence ?? null) as
    | 'high'
    | 'medium'
    | 'low'
    | null;

  const result: PriceLookupResult = {
    tokenIdOrCert: cert,
    cardName,
    setName,
    grade,
    mainApiFmvCents: null,
    indexApiFmvCents: indexCents,
    recommendedFmvCents: indexCents,
    confidence,
    lastSaleAt,
    imageUrl,
    sources: [
      {
        name: 'Renaiss Index API',
        url: `https://api.renaissos.com/v1/graded/${encodeURIComponent(cert)}`,
      },
    ],
  };

  await interaction.editReply({ embeds: [buildPriceEmbed(result)] });
  console.log(
    `${LOG_PREFIX} cert ok user=${interaction.user.id} cert=${cert} fmv=${indexCents}`
  );
};

// ---------------------------------------------------------------------------
// Per-user rate limit + dispatch
// ---------------------------------------------------------------------------

/**
 * Atomically consume one token from the per-user price-command bucket.
 *
 * Capacity 5, refill 5/min. The bucket key namespaces by userId so a chatty
 * user does not slow other users down.
 */
const consumePriceToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:price:${userId}`, 5, 5);
};

const data = new SlashCommandBuilder()
  .setName('price')
  .setDescription('Look up FMV for a Renaiss tokenId or graded cert.')
  .addSubcommand((sc) =>
    sc
      .setName('token')
      .setDescription('Look up by Renaiss Registry V3 tokenId.')
      .addStringOption((opt) =>
        opt
          .setName('tokenid')
          .setDescription('Renaiss tokenId (decimal string).')
          .setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName('cert')
      .setDescription('Look up by graded slab cert (PSA / BGS / CGC / SGC).')
      .addStringOption((opt) =>
        opt
          .setName('cert')
          .setDescription('Cert serial, e.g. PSA73628064.')
          .setRequired(true)
      )
  );

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  // Rate-limit BEFORE deferring so an exhausted user does not consume a
  // deferred reply slot.
  const allowed = await consumePriceToken(interaction.user.id);
  if (!allowed) {
    const slowEmbed = new EmbedBuilder()
      .setTitle('Slow down please')
      .setColor(0xe67e22)
      .setDescription(
        'You have hit the /price rate limit (5 per minute). Try again shortly.'
      )
      .addFields(buildDisclosureField())
      .setFooter(discordEmbedFooter());
    await interaction.reply({ embeds: [slowEmbed], ...ephemeral });
    return;
  }

  // Defer so we have up to 15 minutes to respond (API can take 200ms-3s).
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error(`${LOG_PREFIX} deferReply failed:`, err);
    return;
  }

  const sub = interaction.options.getSubcommand();
  try {
    switch (sub) {
      case 'token':
        await handleToken(interaction);
        return;
      case 'cert':
        await handleCert(interaction);
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

export const priceCommand: Command = { data, handler };


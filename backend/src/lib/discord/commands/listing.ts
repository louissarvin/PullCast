/**
 * `/listing` slash command. Deterministic price-range + AI-written explanation
 * for a graded cert or Renaiss tokenId.
 *
 * The NUMBERS in the embed are computed deterministically from real trade /
 * FMV data. The AI only writes the EXPLANATION. Same safety boundary as in
 * `lib/anthropic/listing.ts`.
 *
 * Rate-limit: shares the `discord:command:ai:<userId>` bucket with /explain
 * because both are AI-cost-heavy. Capacity 3, refill 3/min.
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
  buildListingEmbed,
} from '../embed-builders.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';
import { listingSuggest } from '../../anthropic/index.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';

const LOG_PREFIX = '[listing]';

const CERT_RX = /^(PSA|BGS|CGC|SGC)\d{6,12}$/i;
const TOKEN_RX = /^[0-9]{1,78}$/;

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const consumeAiToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:ai:${userId}`, 3, 3);
};

const handleCert = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const certRaw = interaction.options.getString('cert', true);
  const cert = certRaw.trim();

  if (!CERT_RX.test(cert)) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          'Cert format must be PSA/BGS/CGC/SGC followed by 6-12 digits (e.g. PSA73628064).'
        ),
      ],
    });
    return;
  }

  const result = await listingSuggest({ cert: cert.toUpperCase() });
  await interaction.editReply({
    embeds: [
      buildListingEmbed({
        text: result.text,
        sources: result.sources,
        card: result.card,
        rangeLowUsdCents: result.rangeLowUsdCents,
        rangeMidUsdCents: result.rangeMidUsdCents,
        rangeHighUsdCents: result.rangeHighUsdCents,
        comparableCount: result.comparableCount,
        primaryFmvUsdCents: result.primaryFmvUsdCents,
        primarySource: result.primarySource,
        confidence: result.confidence,
        refused: result.refused,
      }),
    ],
  });
  console.log(
    `${LOG_PREFIX} cert user=${interaction.user.id} cert=${cert} refused=${result.refused?.reason ?? 'no'} mid=${result.rangeMidUsdCents}`
  );
};

const handleToken = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const tokenRaw = interaction.options.getString('tokenid', true);
  const tokenId = tokenRaw.trim();

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

  const result = await listingSuggest({ tokenId });
  await interaction.editReply({
    embeds: [
      buildListingEmbed({
        text: result.text,
        sources: result.sources,
        card: result.card,
        rangeLowUsdCents: result.rangeLowUsdCents,
        rangeMidUsdCents: result.rangeMidUsdCents,
        rangeHighUsdCents: result.rangeHighUsdCents,
        comparableCount: result.comparableCount,
        primaryFmvUsdCents: result.primaryFmvUsdCents,
        primarySource: result.primarySource,
        confidence: result.confidence,
        refused: result.refused,
      }),
    ],
  });
  console.log(
    `${LOG_PREFIX} token user=${interaction.user.id} tokenId=${tokenId} refused=${result.refused?.reason ?? 'no'} mid=${result.rangeMidUsdCents}`
  );
};

const data = new SlashCommandBuilder()
  .setName('listing')
  .setDescription('Suggested listing price range with AI-written reasoning.')
  .addSubcommand((sc) =>
    sc
      .setName('cert')
      .setDescription('Listing suggestion by graded cert.')
      .addStringOption((o) =>
        o.setName('cert').setDescription('Cert serial, e.g. PSA73628064.').setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName('token')
      .setDescription('Listing suggestion by Renaiss tokenId.')
      .addStringOption((o) =>
        o.setName('tokenid').setDescription('Decimal tokenId.').setRequired(true)
      )
  );

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const allowed = await consumeAiToken(interaction.user.id);
  if (!allowed) {
    const slowEmbed = new EmbedBuilder()
      .setTitle('Slow down please')
      .setColor(0xe67e22)
      .setDescription(
        'You have hit the AI command rate limit (3 per minute). Try again shortly.'
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
      case 'token':
        await handleToken(interaction);
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

export const listingCommand: Command = { data, handler };

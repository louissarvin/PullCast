/**
 * `/explain` slash command. Grounded AI answer about a cert or tokenId.
 *
 * Subcommands:
 *   - /explain cert  cert:<string>     question:<string>
 *   - /explain token tokenid:<string>  question:<string>
 *
 * Rate-limit (BEFORE deferReply so an exhausted user does not consume a
 * deferred slot): `discord:command:ai:<userId>` capacity 3, refill 3/min.
 * AI is materially more expensive than /price so the bucket is narrower.
 *
 * All AI output goes through the citation-guard + disclosure-footer pipeline
 * inside `explainAsk`. The command surface is only responsible for input
 * validation, deferReply ergonomics, and rendering the embed.
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
  buildExplainEmbed,
} from '../embed-builders.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';
import { explainAsk } from '../../anthropic/index.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';

const LOG_PREFIX = '[explain]';

const CERT_RX = /^(PSA|BGS|CGC|SGC)\d{6,12}$/i;
const TOKEN_RX = /^[0-9]{1,78}$/;

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const MIN_QUESTION_CHARS = 5;
const MAX_QUESTION_CHARS = 800;

// H-2: cheap prompt-injection denylist mirroring the REST route guard.
const PROMPT_INJECTION_RE = /ignore previous|ignore prior|system prompt|<source-|\[source-|<\/source-/i;
const UNSAFE_QUESTION_MSG =
  'PullCast cannot follow that instruction. Try rephrasing the question.';

const consumeAiToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:ai:${userId}`, 3, 3);
};

const handleCert = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const certRaw = interaction.options.getString('cert', true);
  const questionRaw = interaction.options.getString('question', true);
  const cert = certRaw.trim();
  const question = questionRaw.trim();

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
  if (question.length < MIN_QUESTION_CHARS || question.length > MAX_QUESTION_CHARS) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          `Question must be ${MIN_QUESTION_CHARS}-${MAX_QUESTION_CHARS} characters.`
        ),
      ],
    });
    return;
  }
  if (PROMPT_INJECTION_RE.test(question)) {
    await interaction.editReply({ embeds: [buildErrorEmbed(UNSAFE_QUESTION_MSG)] });
    return;
  }

  const certUpper = cert.toUpperCase();
  const result = await explainAsk({
    subject: { kind: 'cert', cert: certUpper },
    question,
  });

  await interaction.editReply({
    embeds: [
      buildExplainEmbed({
        question,
        text: result.text,
        sources: result.sources,
        refused: result.refused,
      }),
    ],
  });
  console.log(
    `${LOG_PREFIX} cert user=${interaction.user.id} cert=${certUpper} refused=${result.refused?.reason ?? 'no'}`
  );
};

const handleToken = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const tokenRaw = interaction.options.getString('tokenid', true);
  const questionRaw = interaction.options.getString('question', true);
  const tokenId = tokenRaw.trim();
  const question = questionRaw.trim();

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
  if (question.length < MIN_QUESTION_CHARS || question.length > MAX_QUESTION_CHARS) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          `Question must be ${MIN_QUESTION_CHARS}-${MAX_QUESTION_CHARS} characters.`
        ),
      ],
    });
    return;
  }
  if (PROMPT_INJECTION_RE.test(question)) {
    await interaction.editReply({ embeds: [buildErrorEmbed(UNSAFE_QUESTION_MSG)] });
    return;
  }

  const result = await explainAsk({
    subject: { kind: 'tokenId', tokenId },
    question,
  });

  await interaction.editReply({
    embeds: [
      buildExplainEmbed({
        question,
        text: result.text,
        sources: result.sources,
        refused: result.refused,
      }),
    ],
  });
  console.log(
    `${LOG_PREFIX} token user=${interaction.user.id} tokenId=${tokenId} refused=${result.refused?.reason ?? 'no'}`
  );
};

const data = new SlashCommandBuilder()
  .setName('explain')
  .setDescription('Grounded AI answer about a cert or Renaiss tokenId.')
  .addSubcommand((sc) =>
    sc
      .setName('cert')
      .setDescription('Explain a graded cert (PSA / BGS / CGC / SGC).')
      .addStringOption((o) =>
        o.setName('cert').setDescription('Cert serial, e.g. PSA73628064.').setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName('question')
          .setDescription('Your question (5-800 chars).')
          .setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName('token')
      .setDescription('Explain a Renaiss collectible by tokenId.')
      .addStringOption((o) =>
        o.setName('tokenid').setDescription('Decimal tokenId.').setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName('question')
          .setDescription('Your question (5-800 chars).')
          .setRequired(true)
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

export const explainCommand: Command = { data, handler };

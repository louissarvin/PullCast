/**
 * `/report` slash command (M8 — data-issue report to Renaiss OS Index).
 *
 *   /report cert:<value>     - open a modal pre-filled with the cert
 *   /report tokenId:<value>  - open a modal pre-filled with the tokenId
 *
 * The slash command handler synchronously opens a modal (Discord requires the
 * modal to be shown as the FIRST interaction response — no deferReply).
 *
 * On modal submit we POST to Renaiss OS Index via `renaissIndex.reportIssue`
 * and reply with an ephemeral confirmation embed showing the reportId (when
 * upstream returned one) plus the mandatory beta / experimental / not
 * financial advice disclosure.
 *
 * Rate limit: per-user 3 / minute via the shared token bucket.
 *
 * Also exposes a `showReportModalFromButton` helper so `/valuate cert:` can
 * open the same modal from its "Report missing coverage" button without
 * duplicating the modal-building logic.
 */

import {
  ActionRowBuilder,
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import type { Command } from '../command-registry.ts';
import {
  buildDisclosureField,
  buildErrorEmbed,
} from '../embed-builders.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';
import {
  IndexApiError,
  renaissIndex,
} from '../../renaiss-index/index.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';
import {
  CERT_RX,
  REPORT_BUTTON_PREFIX,
  REPORT_MODAL_PREFIX,
  TOKEN_RX,
  parseButtonCustomId,
  parseModalCustomId,
} from './report-customid.ts';

const LOG_PREFIX = '[report]';

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

// Re-export the prefixes so index.ts / valuate.ts callers can keep their
// existing import path.
export { REPORT_MODAL_PREFIX, REPORT_BUTTON_PREFIX } from './report-customid.ts';
export { buildReportMissingCoverageCustomId } from './report-customid.ts';

const MODAL_REASON_INPUT_ID = 'reason';
const MODAL_EVIDENCE_INPUT_ID = 'evidence';

const consumeReportToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:report:${userId}`, 3, 3);
};

/**
 * Build the modal Discord shows to collect the reason + optional evidence.
 * The `customId` encodes what identifies the card so the modal-submit handler
 * can build the payload without re-fetching state (Discord modals are
 * stateless — the interaction can happen many minutes after the user typed
 * the command).
 */
const buildReportModal = (kind: 'cert' | 'token', value: string): ModalBuilder => {
  const modal = new ModalBuilder()
    .setCustomId(`${REPORT_MODAL_PREFIX}${kind}:${value}`)
    .setTitle(`Report a data issue`);

  const reasonInput = new TextInputBuilder()
    .setCustomId(MODAL_REASON_INPUT_ID)
    .setLabel("What's wrong?")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(500)
    .setPlaceholder(
      kind === 'cert'
        ? `e.g. Price for ${value} looks stale / wrong.`
        : `e.g. Card metadata for ${value} does not match the printed card.`
    );

  const evidenceInput = new TextInputBuilder()
    .setCustomId(MODAL_EVIDENCE_INPUT_ID)
    .setLabel('Evidence URL (optional)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(500)
    .setPlaceholder('https://... a listing / recent sale / photo');

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(evidenceInput)
  );

  return modal;
};

// ---------------------------------------------------------------------------
// /report handler — opens the modal.
// ---------------------------------------------------------------------------
const handleSlash = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  // Rate-limit BEFORE showing the modal. If we open a modal and the caller is
  // over budget, we cannot cancel gracefully after the fact.
  const allowed = await consumeReportToken(interaction.user.id);
  if (!allowed) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'You have hit the /report rate limit (3 per minute). Please try again in a moment.'
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  const certRaw = interaction.options.getString('cert');
  const tokenRaw = interaction.options.getString('tokenid');

  // Exactly one of cert / tokenId must be provided. Slash options do not
  // enforce mutual exclusivity on the wire so we validate here.
  if ((certRaw && tokenRaw) || (!certRaw && !tokenRaw)) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'Provide exactly one of `cert` or `tokenId`.'
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  let kind: 'cert' | 'token';
  let value: string;
  if (certRaw) {
    const cert = certRaw.trim().toUpperCase();
    if (!CERT_RX.test(cert)) {
      await interaction.reply({
        embeds: [
          buildErrorEmbed(
            'Cert must be PSA/BGS/CGC/SGC followed by 6-12 digits (e.g. PSA73628064).'
          ),
        ],
        ...ephemeral,
      });
      return;
    }
    kind = 'cert';
    value = cert;
  } else {
    const token = (tokenRaw ?? '').trim();
    if (!TOKEN_RX.test(token)) {
      await interaction.reply({
        embeds: [
          buildErrorEmbed('tokenId must be a positive integer.'),
        ],
        ...ephemeral,
      });
      return;
    }
    kind = 'token';
    value = token;
  }

  const modal = buildReportModal(kind, value);
  try {
    await interaction.showModal(modal);
  } catch (err) {
    console.error(`${LOG_PREFIX} showModal failed user=${interaction.user.id}:`, err);
  }
};

// ---------------------------------------------------------------------------
// Modal-submit handler.
// ---------------------------------------------------------------------------
const handleModalSubmit = async (
  interaction: ModalSubmitInteraction
): Promise<void> => {
  const parsed = parseModalCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed('This report form is stale. Run /report again.'),
      ],
      ...ephemeral,
    });
    return;
  }

  // Consume a token again on submit so a user who spammed modals cannot
  // bypass the rate limit.
  const allowed = await consumeReportToken(interaction.user.id);
  if (!allowed) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'You have hit the /report rate limit (3 per minute). Please try again in a moment.'
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  // Discord modal fields are always strings — never null when required.
  const reasonRaw = interaction.fields.getTextInputValue(MODAL_REASON_INPUT_ID);
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
  if (reason.length === 0) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Reason is required.')],
      ...ephemeral,
    });
    return;
  }

  let evidence = '';
  try {
    evidence = interaction.fields.getTextInputValue(MODAL_EVIDENCE_INPUT_ID) ?? '';
  } catch {
    // Optional field may not be present in older Discord clients.
    evidence = '';
  }
  const evidenceTrimmed = evidence.trim();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const result = await renaissIndex.reportIssue({
      reason,
      ...(evidenceTrimmed.length > 0 ? { evidence: evidenceTrimmed } : {}),
      submitterHandle: `discord:${interaction.user.id}`,
      card:
        parsed.kind === 'cert'
          ? { cert: parsed.value }
          : { tokenId: parsed.value },
    });

    const embed = new EmbedBuilder()
      .setTitle('Report received')
      .setColor(0x2ecc71)
      .setDescription(
        `Thanks — Renaiss will review this. Beta data / experimental references / not financial advice.`
      )
      .addFields(
        {
          name: parsed.kind === 'cert' ? 'Cert' : 'Token ID',
          value: parsed.value,
          inline: true,
        },
        ...(result.reportId
          ? [{ name: 'Report ID', value: result.reportId, inline: true }]
          : []),
        buildDisclosureField()
      )
      .setFooter(discordEmbedFooter());

    await interaction.editReply({ embeds: [embed] });
    console.log(
      `${LOG_PREFIX} submitted user=${interaction.user.id} kind=${parsed.kind} reportId=${result.reportId ?? 'n/a'}`
    );
  } catch (err) {
    if (err instanceof IndexApiError) {
      console.warn(
        `${LOG_PREFIX} upstream error status=${err.status} user=${interaction.user.id}`
      );
      const msg =
        err.status === 429
          ? 'Renaiss OS Index rate limit reached. Please try again in a moment.'
          : err.status === 422
            ? 'The report was rejected as invalid. Please double-check and try again.'
            : 'Renaiss OS Index unreachable. Please try again in a moment.';
      await interaction.editReply({ embeds: [buildErrorEmbed(msg)] });
      return;
    }
    console.error(`${LOG_PREFIX} unexpected error user=${interaction.user.id}:`, err);
    await interaction.editReply({
      embeds: [
        buildErrorEmbed('Something went wrong. Please try again in a moment.'),
      ],
    });
  }
};

// ---------------------------------------------------------------------------
// Button handler — opens the modal when a user clicks "Report missing
// coverage" from the /valuate cert not-found embed.
// ---------------------------------------------------------------------------
const handleButton = async (interaction: ButtonInteraction): Promise<void> => {
  const parsed = parseButtonCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Button is stale. Run /valuate again.')],
      ...ephemeral,
    });
    return;
  }

  // Rate-limit here too — a spammy user could click the button many times.
  const allowed = await consumeReportToken(interaction.user.id);
  if (!allowed) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'You have hit the /report rate limit (3 per minute). Please try again in a moment.'
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  const modal = buildReportModal(parsed.kind, parsed.value);
  try {
    await interaction.showModal(modal);
  } catch (err) {
    console.error(`${LOG_PREFIX} button showModal failed user=${interaction.user.id}:`, err);
  }
};

// ---------------------------------------------------------------------------
// Slash command builder + wiring.
// ---------------------------------------------------------------------------
const data = new SlashCommandBuilder()
  .setName('report')
  .setDescription(
    'Report a data issue (wrong price, wrong card, stale data) to Renaiss OS Index.'
  )
  .addStringOption((opt) =>
    opt
      .setName('cert')
      .setDescription('Cert serial being reported (e.g. PSA73628064).')
      .setRequired(false)
  )
  .addStringOption((opt) =>
    opt
      .setName('tokenid')
      .setDescription('Collectible token id being reported.')
      .setRequired(false)
  );

export const reportCommand: Command = {
  data,
  handler: handleSlash,
  buttons: [
    { prefix: REPORT_BUTTON_PREFIX, handler: handleButton },
  ],
  modals: [
    { prefix: REPORT_MODAL_PREFIX, handler: handleModalSubmit },
  ],
};

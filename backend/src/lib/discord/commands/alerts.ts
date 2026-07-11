/**
 * `/alerts` slash command group.
 *
 * Subcommands:
 *  - subscribe     - subscribe the current channel to Big Trade Alerts at the
 *                    default threshold ($5,000).
 *  - unsubscribe   - soft-delete this channel's Big Trade Alert subscription.
 *  - threshold     - override the per-channel USD threshold (persisted in
 *                    Subscription.metadata).
 *  - test          - admin-only dry run: post a digest of the last 5 qualifying
 *                    trades from the live Renaiss OS Index feed to this channel.
 *
 * Replies to admin actions are ephemeral. The test digest is a non-ephemeral
 * channel post so admins can preview how a real alert looks.
 *
 * Ownership + safety:
 *  - Only the invoking Discord user (createdByUserId) can unsubscribe or
 *    change the threshold for a subscription they created (mirrors the
 *    /pullcast unsubscribe pattern).
 *  - `test` requires the ManageChannels permission on the current channel so
 *    a rando member cannot spam the channel with previews.
 *  - `threshold` is bounded 1_000..100_000_000 cents ($10 to $1M) so a typo
 *    can't disable the alert entirely (0) or overflow display formatting.
 */

import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

import { prismaQuery } from '../../prisma.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';
import { buildDisclosureField, buildErrorEmbed } from '../embed-builders.ts';
import { renaissIndex, IndexApiError } from '../../renaiss-index/index.ts';
import {
  BIG_TRADE_USD_CENTS_DEFAULT,
  BIG_TRADE_POLL_LIMIT,
} from '../../../config/main-config.ts';
import {
  buildBigTradeAlertEmbed,
  buildBigTradeDigestEmbed,
  filterQualifyingTrades,
  parseChannelThresholdCents,
} from '../../../workers/bigTradeAlert.filters.ts';
import type { Command } from '../command-registry.ts';

const LOG_PREFIX = '[commands:alerts]';

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const MIN_THRESHOLD_CENTS = 1_000; // $10
const MAX_THRESHOLD_CENTS = 100_000_000; // $1,000,000
const TEST_PREVIEW_LIMIT = 5;

const requireGuild = (
  interaction: ChatInputCommandInteraction
): { guildId: string; channelId: string } | null => {
  if (!interaction.inGuild() || interaction.guildId === null) return null;
  return { guildId: interaction.guildId, channelId: interaction.channelId };
};

const formatUsd = (cents: number): string => {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
};

const buildMetadataJson = (thresholdCents: number): string => {
  return JSON.stringify({ threshold_usd_cents: thresholdCents });
};

// ---------------------------------------------------------------------------
// subscribe
// ---------------------------------------------------------------------------

const handleSubscribe = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const ctx = requireGuild(interaction);
  if (ctx === null) {
    await interaction.reply({
      embeds: [buildErrorEmbed('This command must be run in a server channel.')],
      ...ephemeral,
    });
    return;
  }

  // If an existing active BIG_TRADE_ALERT sub already covers this channel, do
  // not duplicate. Return the existing threshold.
  let existing;
  try {
    existing = await prismaQuery.subscription.findFirst({
      where: {
        discordChannelId: ctx.channelId,
        type: 'BIG_TRADE_ALERT',
        deletedAt: null,
      },
      select: { id: true, metadata: true },
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} subscribe lookup failed:`, err);
    await interaction.reply({
      embeds: [buildErrorEmbed('Could not check existing subscriptions. Please try again.')],
      ...ephemeral,
    });
    return;
  }

  if (existing !== null) {
    const thr =
      parseChannelThresholdCents(existing.metadata) ?? BIG_TRADE_USD_CENTS_DEFAULT;
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Already subscribed')
          .setColor(0x95a5a6)
          .setDescription(
            [
              `This channel already receives Big Trade Alerts at ${formatUsd(thr)}.`,
              '',
              'Use `/alerts threshold usd:<amount>` to change the threshold, or',
              '`/alerts unsubscribe` to stop alerts.',
            ].join('\n')
          )
          .addFields(buildDisclosureField())
          .setFooter(discordEmbedFooter()),
      ],
      ...ephemeral,
    });
    return;
  }

  try {
    const created = await prismaQuery.subscription.create({
      data: {
        discordGuildId: ctx.guildId,
        discordChannelId: ctx.channelId,
        type: 'BIG_TRADE_ALERT',
        metadata: buildMetadataJson(BIG_TRADE_USD_CENTS_DEFAULT),
        createdByUserId: interaction.user.id,
      },
      select: { id: true },
    });
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Alerts on')
          .setColor(0x2ecc71)
          .setDescription(
            [
              `This channel will receive Big Trade Alerts for trades at or above ${formatUsd(BIG_TRADE_USD_CENTS_DEFAULT)}.`,
              `Subscription id: \`${created.id}\``,
              '',
              'Adjust with `/alerts threshold usd:<amount>` or stop with `/alerts unsubscribe`.',
            ].join('\n')
          )
          .addFields(buildDisclosureField())
          .setFooter(discordEmbedFooter()),
      ],
      ...ephemeral,
    });
    console.log(
      `${LOG_PREFIX} subscribe ok sub=${created.id} channel=${ctx.channelId} threshold_usd_cents=${BIG_TRADE_USD_CENTS_DEFAULT}`
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} subscribe failed:`, err);
    await interaction.reply({
      embeds: [buildErrorEmbed('Could not save subscription. Please try again.')],
      ...ephemeral,
    });
  }
};

// ---------------------------------------------------------------------------
// unsubscribe
// ---------------------------------------------------------------------------

const handleUnsubscribe = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const ctx = requireGuild(interaction);
  if (ctx === null) {
    await interaction.reply({
      embeds: [buildErrorEmbed('This command must be run in a server channel.')],
      ...ephemeral,
    });
    return;
  }

  let sub;
  try {
    sub = await prismaQuery.subscription.findFirst({
      where: {
        discordChannelId: ctx.channelId,
        type: 'BIG_TRADE_ALERT',
        deletedAt: null,
      },
      select: { id: true, createdByUserId: true },
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} unsubscribe lookup failed:`, err);
    await interaction.reply({
      embeds: [buildErrorEmbed('Could not look up subscription. Please try again.')],
      ...ephemeral,
    });
    return;
  }

  if (sub === null) {
    await interaction.reply({
      embeds: [buildErrorEmbed('This channel has no active Big Trade Alert subscription.')],
      ...ephemeral,
    });
    return;
  }

  // Ownership check: only the creator may unsubscribe (mirrors /pullcast).
  // Server admins can bypass via ManageChannels permission.
  const isAdmin = interaction.memberPermissions?.has(
    PermissionFlagsBits.ManageChannels
  );
  if (sub.createdByUserId !== interaction.user.id && isAdmin !== true) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'Only the user who subscribed this channel (or a server admin) can unsubscribe.'
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  try {
    await prismaQuery.subscription.update({
      where: { id: sub.id },
      data: { deletedAt: new Date() },
    });
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Alerts off')
          .setColor(0xe67e22)
          .setDescription(`Removed Big Trade Alert subscription \`${sub.id}\`.`)
          .addFields(buildDisclosureField())
          .setFooter(discordEmbedFooter()),
      ],
      ...ephemeral,
    });
    console.log(`${LOG_PREFIX} unsubscribe ok sub=${sub.id} channel=${ctx.channelId}`);
  } catch (err) {
    console.error(`${LOG_PREFIX} unsubscribe update failed:`, err);
    await interaction.reply({
      embeds: [buildErrorEmbed('Could not unsubscribe. Please try again.')],
      ...ephemeral,
    });
  }
};

// ---------------------------------------------------------------------------
// threshold
// ---------------------------------------------------------------------------

const handleThreshold = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const ctx = requireGuild(interaction);
  if (ctx === null) {
    await interaction.reply({
      embeds: [buildErrorEmbed('This command must be run in a server channel.')],
      ...ephemeral,
    });
    return;
  }

  const usdInput = interaction.options.getNumber('usd', true);
  if (!Number.isFinite(usdInput) || usdInput <= 0) {
    await interaction.reply({
      embeds: [buildErrorEmbed('`usd` must be a positive number.')],
      ...ephemeral,
    });
    return;
  }

  const cents = Math.round(usdInput * 100);
  if (cents < MIN_THRESHOLD_CENTS || cents > MAX_THRESHOLD_CENTS) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          `Threshold must be between ${formatUsd(MIN_THRESHOLD_CENTS)} and ${formatUsd(MAX_THRESHOLD_CENTS)}.`
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  let sub;
  try {
    sub = await prismaQuery.subscription.findFirst({
      where: {
        discordChannelId: ctx.channelId,
        type: 'BIG_TRADE_ALERT',
        deletedAt: null,
      },
      select: { id: true, createdByUserId: true },
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} threshold lookup failed:`, err);
    await interaction.reply({
      embeds: [buildErrorEmbed('Could not look up subscription. Please try again.')],
      ...ephemeral,
    });
    return;
  }

  if (sub === null) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'This channel has no active Big Trade Alert subscription. Run `/alerts subscribe` first.'
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  const isAdmin = interaction.memberPermissions?.has(
    PermissionFlagsBits.ManageChannels
  );
  if (sub.createdByUserId !== interaction.user.id && isAdmin !== true) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'Only the user who subscribed this channel (or a server admin) can change the threshold.'
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  try {
    await prismaQuery.subscription.update({
      where: { id: sub.id },
      data: { metadata: buildMetadataJson(cents) },
    });
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Threshold updated')
          .setColor(0x3498db)
          .setDescription(
            `Big Trade Alerts in this channel now fire at ${formatUsd(cents)} and above.`
          )
          .addFields(buildDisclosureField())
          .setFooter(discordEmbedFooter()),
      ],
      ...ephemeral,
    });
    console.log(
      `${LOG_PREFIX} threshold updated sub=${sub.id} channel=${ctx.channelId} threshold_usd_cents=${cents}`
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} threshold update failed:`, err);
    await interaction.reply({
      embeds: [buildErrorEmbed('Could not update threshold. Please try again.')],
      ...ephemeral,
    });
  }
};

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

const handleTest = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const ctx = requireGuild(interaction);
  if (ctx === null) {
    await interaction.reply({
      embeds: [buildErrorEmbed('This command must be run in a server channel.')],
      ...ephemeral,
    });
    return;
  }

  const isAdmin = interaction.memberPermissions?.has(
    PermissionFlagsBits.ManageChannels
  );
  if (isAdmin !== true) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          '`/alerts test` requires the Manage Channels permission on this channel.'
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  // Effective threshold: existing subscription override OR default.
  let threshold = BIG_TRADE_USD_CENTS_DEFAULT;
  try {
    const sub = await prismaQuery.subscription.findFirst({
      where: {
        discordChannelId: ctx.channelId,
        type: 'BIG_TRADE_ALERT',
        deletedAt: null,
      },
      select: { metadata: true },
    });
    if (sub !== null) {
      threshold = parseChannelThresholdCents(sub.metadata) ?? BIG_TRADE_USD_CENTS_DEFAULT;
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} test threshold lookup failed, using default:`, err);
  }

  await interaction.deferReply(ephemeral);

  let trades;
  try {
    trades = await renaissIndex.getRecentTrades({ limit: BIG_TRADE_POLL_LIMIT });
  } catch (err) {
    if (err instanceof IndexApiError) {
      await interaction.editReply({
        embeds: [
          buildErrorEmbed(
            `Renaiss Index API returned ${err.status ?? 'error'}; try again in a moment.`
          ),
        ],
      });
    } else {
      console.error(`${LOG_PREFIX} test fetch failed:`, err);
      await interaction.editReply({
        embeds: [buildErrorEmbed('Could not fetch recent trades.')],
      });
    }
    return;
  }

  const qualifying = filterQualifyingTrades({
    trades,
    thresholdCents: threshold,
    cursorMs: null, // test mode: show everything, do not consult cursor
  }).slice(-TEST_PREVIEW_LIMIT); // last 5 (oldest to newest per filter sort)

  if (qualifying.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('No qualifying trades')
          .setColor(0x95a5a6)
          .setDescription(
            [
              `Fetched ${trades.length} recent trade(s) from the Renaiss OS Index.`,
              `None met the ${formatUsd(threshold)} threshold with kind=transaction.`,
            ].join('\n')
          )
          .addFields(buildDisclosureField())
          .setFooter(discordEmbedFooter()),
      ],
    });
    return;
  }

  // Post the digest publicly so the admin can see how real alerts render.
  const channel = interaction.channel;
  if (channel === null || !channel.isTextBased() || !('send' in channel)) {
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          'Cannot preview: current channel does not accept bot messages.'
        ),
      ],
    });
    return;
  }

  try {
    // Send each embed as its own message so the admin sees the real per-trade
    // shape (not just the digest fallback).
    for (const q of qualifying) {
      await channel.send({ embeds: [buildBigTradeAlertEmbed({ qualifying: q })] });
    }
    // Also send the digest so admins see both surfaces.
    await channel.send({
      embeds: [
        buildBigTradeDigestEmbed({
          qualifying,
          totalCount: qualifying.length,
        }),
      ],
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} test post failed channel=${ctx.channelId}:`, err);
    await interaction.editReply({
      embeds: [buildErrorEmbed('Could not post preview. Check bot permissions.')],
    });
    return;
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Preview posted')
        .setColor(0x2ecc71)
        .setDescription(
          `Posted ${qualifying.length} sample alert(s) + a digest preview to this channel.`
        )
        .addFields(buildDisclosureField())
        .setFooter(discordEmbedFooter()),
    ],
  });
  console.log(
    `${LOG_PREFIX} test previewed count=${qualifying.length} channel=${ctx.channelId} threshold=${threshold}`
  );
};

// ---------------------------------------------------------------------------
// Command spec
// ---------------------------------------------------------------------------

const data = new SlashCommandBuilder()
  .setName('alerts')
  .setDescription('Big Trade Alerts: notify this channel on large trades from the Renaiss OS Index.')
  .addSubcommand((sc) =>
    sc
      .setName('subscribe')
      .setDescription(
        `Subscribe this channel to Big Trade Alerts at $${(BIG_TRADE_USD_CENTS_DEFAULT / 100).toLocaleString('en-US')} threshold.`
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName('unsubscribe')
      .setDescription('Remove this channel\'s Big Trade Alert subscription.')
  )
  .addSubcommand((sc) =>
    sc
      .setName('threshold')
      .setDescription('Set the USD threshold for this channel\'s Big Trade Alerts.')
      .addNumberOption((opt) =>
        opt
          .setName('usd')
          .setDescription('Minimum trade value in USD (e.g. 5000).')
          .setRequired(true)
          .setMinValue(MIN_THRESHOLD_CENTS / 100)
          .setMaxValue(MAX_THRESHOLD_CENTS / 100)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName('test')
      .setDescription('Admin-only: post the last 5 qualifying trades as a preview.')
  );

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'subscribe':
      await handleSubscribe(interaction);
      return;
    case 'unsubscribe':
      await handleUnsubscribe(interaction);
      return;
    case 'threshold':
      await handleThreshold(interaction);
      return;
    case 'test':
      await handleTest(interaction);
      return;
    default:
      await interaction.reply({
        embeds: [buildErrorEmbed(`Unknown subcommand: ${sub}`)],
        ...ephemeral,
      });
  }
};

export const alertsCommand: Command = { data, handler };


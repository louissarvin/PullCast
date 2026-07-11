/**
 * `/pullcast` slash command group.
 *
 * Subcommands:
 *  - subscribe   - subscribe the current channel to a wallet OR a pack
 *  - unsubscribe - soft-delete a subscription owned by the current channel
 *  - list        - list this channel's active subscriptions
 *  - help        - command reference embed
 *
 * Replies are ephemeral by default (only the invoking user sees them) so the
 * channel is not spammed during onboarding.
 *
 * Validation:
 *  - Wallet addresses must match /^0x[a-fA-F0-9]{40}$/ and are lowercased
 *    before storage.
 *  - Pack slugs must appear in INDEXER_TRACKED_PACKS (config-driven, so adding
 *    a pack means restarting the worker, not editing this file).
 */

import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { INDEXER_TRACKED_PACKS } from '../../../config/main-config.ts';
import { prismaQuery } from '../../prisma.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';
import { buildDisclosureField, buildErrorEmbed } from '../embed-builders.ts';
import type { Command } from '../command-registry.ts';

const LOG_PREFIX = '[commands]';

const WALLET_RX = /^0x[a-fA-F0-9]{40}$/;

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const sanitizePackSlug = (raw: string): string | null => {
  const norm = raw.trim().toLowerCase();
  if (!INDEXER_TRACKED_PACKS.includes(norm)) return null;
  return norm;
};

const sanitizeWallet = (raw: string): string | null => {
  if (!WALLET_RX.test(raw)) return null;
  return raw.toLowerCase();
};

/** Detect Prisma unique-violation without depending on the generated client type. */
const isUniqueViolation = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code === 'P2002';
};

const requireGuild = (
  interaction: ChatInputCommandInteraction
): { guildId: string; channelId: string } | null => {
  if (!interaction.inGuild() || interaction.guildId === null) return null;
  return { guildId: interaction.guildId, channelId: interaction.channelId };
};

// ---------------------------------------------------------------------------
// /pullcast help (also exported standalone as /help via help.ts)
// ---------------------------------------------------------------------------

export const buildHelpEmbed = (): EmbedBuilder => {
  const lines = [
    '`/pullcast subscribe wallet:<0x..>` - notify this channel on pulls by this wallet.',
    '`/pullcast subscribe pack:<slug>` - notify this channel on all pulls from a pack.',
    '`/pullcast unsubscribe` - list your subscriptions, then pass `id:<sub-id>` to remove.',
    '`/pullcast list` - show this channel\'s active subscriptions.',
    '`/pullcast optout wallet:<0x..>` - suppress posts and public listings for a wallet.',
    '`/pullcast optout-remove wallet:<0x..>` - remove an existing opt-out for a wallet.',
    '`/pullcast help` - this message.',
    '',
    `Tracked packs: ${INDEXER_TRACKED_PACKS.join(', ') || '(none)'}`,
    '',
    'Opt-out note: opt-out is self-service and trusts the caller\'s claim.',
    'If you do not own the wallet, the owner can request removal via the README.',
  ];
  return new EmbedBuilder()
    .setTitle('PullCast - commands')
    .setColor(0x3498db)
    .setDescription(lines.join('\n'))
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());
};

// ---------------------------------------------------------------------------
// Subcommand handlers
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

  const walletInput = interaction.options.getString('wallet', false);
  const packInput = interaction.options.getString('pack', false);

  // Exactly one of wallet|pack required.
  const hasWallet = typeof walletInput === 'string' && walletInput.length > 0;
  const hasPack = typeof packInput === 'string' && packInput.length > 0;
  if (hasWallet === hasPack) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'Provide exactly one of `wallet:<0x...>` or `pack:<slug>`. Try `/pullcast help` for examples.'
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  let walletAddress: string | null = null;
  let packSlug: string | null = null;

  if (hasWallet) {
    const w = sanitizeWallet(walletInput as string);
    if (w === null) {
      await interaction.reply({
        embeds: [
          buildErrorEmbed('Wallet must be a 0x-prefixed 40-character hex address.'),
        ],
        ...ephemeral,
      });
      return;
    }
    walletAddress = w;
  } else {
    const p = sanitizePackSlug(packInput as string);
    if (p === null) {
      await interaction.reply({
        embeds: [
          buildErrorEmbed(
            `Pack must be one of: ${INDEXER_TRACKED_PACKS.join(', ') || '(no tracked packs configured)'}.`
          ),
        ],
        ...ephemeral,
      });
      return;
    }
    packSlug = p;
  }

  try {
    const created = await prismaQuery.subscription.create({
      data: {
        discordGuildId: ctx.guildId,
        discordChannelId: ctx.channelId,
        walletAddress,
        packSlug,
        createdByUserId: interaction.user.id,
      },
      select: { id: true },
    });
    const target = walletAddress ?? `pack:${packSlug ?? ''}`;
    const embed = new EmbedBuilder()
      .setTitle('Subscribed')
      .setColor(0x2ecc71)
      .setDescription(
        `Now watching ${target} in this channel. Subscription id: \`${created.id}\``
      )
      .addFields(buildDisclosureField())
      .setFooter(discordEmbedFooter());
    await interaction.reply({ embeds: [embed], ...ephemeral });
    console.log(
      `${LOG_PREFIX} subscribe ok sub=${created.id} channel=${ctx.channelId} target=${target}`
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      await interaction.reply({
        embeds: [buildErrorEmbed('Already subscribed to that target in this channel.')],
        ...ephemeral,
      });
      return;
    }
    console.error(`${LOG_PREFIX} subscribe failed:`, err);
    await interaction.reply({
      embeds: [buildErrorEmbed('Could not save subscription. Please try again.')],
      ...ephemeral,
    });
  }
};

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

  const idInput = interaction.options.getString('id', false);

  if (typeof idInput === 'string' && idInput.length > 0) {
    // M-6: ownership scoping. Soft-delete only if the subscription belongs to
    // THIS channel AND was created by the invoking Discord user. Without the
    // createdByUserId filter, any channel member could unsubscribe wallets a
    // teammate is watching.
    let sub;
    try {
      sub = await prismaQuery.subscription.findFirst({
        where: {
          id: idInput,
          discordChannelId: ctx.channelId,
          createdByUserId: interaction.user.id,
          deletedAt: null,
        },
        select: { id: true, walletAddress: true, packSlug: true },
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
        embeds: [
          buildErrorEmbed(
            'Subscription not found in this channel or you did not create it. Use `/pullcast list` to see subscriptions you can unsubscribe.'
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
      const target = sub.walletAddress ?? `pack:${sub.packSlug ?? ''}`;
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Unsubscribed')
            .setColor(0xe67e22)
            .setDescription(`Removed subscription \`${sub.id}\` (${target}).`)
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
    return;
  }

  // No id provided -> list this channel's subs as a quick reply.
  let subs: Array<{
    id: string;
    walletAddress: string | null;
    packSlug: string | null;
  }>;
  try {
    subs = await prismaQuery.subscription.findMany({
      where: { discordChannelId: ctx.channelId, deletedAt: null },
      select: { id: true, walletAddress: true, packSlug: true },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} unsubscribe list failed:`, err);
    await interaction.reply({
      embeds: [buildErrorEmbed('Could not load subscriptions. Please try again.')],
      ...ephemeral,
    });
    return;
  }

  if (subs.length === 0) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('No subscriptions')
          .setColor(0x95a5a6)
          .setDescription('This channel has no active subscriptions.')
          .addFields(buildDisclosureField())
          .setFooter(discordEmbedFooter()),
      ],
      ...ephemeral,
    });
    return;
  }

  const lines = subs.map((s) => {
    const target = s.walletAddress ?? `pack:${s.packSlug ?? ''}`;
    return `\`${s.id}\` - ${target}`;
  });
  const embed = new EmbedBuilder()
    .setTitle('Channel subscriptions')
    .setColor(0x3498db)
    .setDescription(
      [
        'Pass the id back to remove a subscription:',
        '`/pullcast unsubscribe id:<sub-id>`',
        '',
        lines.join('\n'),
      ].join('\n')
    )
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());
  await interaction.reply({ embeds: [embed], ...ephemeral });
};

const handleList = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const ctx = requireGuild(interaction);
  if (ctx === null) {
    await interaction.reply({
      embeds: [buildErrorEmbed('This command must be run in a server channel.')],
      ...ephemeral,
    });
    return;
  }

  let subs: Array<{
    id: string;
    walletAddress: string | null;
    packSlug: string | null;
    label: string | null;
    createdAt: Date;
  }>;
  try {
    subs = await prismaQuery.subscription.findMany({
      where: { discordChannelId: ctx.channelId, deletedAt: null },
      select: {
        id: true,
        walletAddress: true,
        packSlug: true,
        label: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} list failed:`, err);
    await interaction.reply({
      embeds: [buildErrorEmbed('Could not load subscriptions. Please try again.')],
      ...ephemeral,
    });
    return;
  }

  if (subs.length === 0) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('No subscriptions')
          .setColor(0x95a5a6)
          .setDescription(
            'No active subscriptions in this channel. Try `/pullcast subscribe pack:<slug>`.'
          )
          .addFields(buildDisclosureField())
          .setFooter(discordEmbedFooter()),
      ],
      ...ephemeral,
    });
    return;
  }

  const fields = subs.map((s) => {
    const target = s.walletAddress ?? `pack:${s.packSlug ?? ''}`;
    const since = `<t:${Math.floor(s.createdAt.getTime() / 1000)}:R>`;
    return {
      name: target,
      value: `id \`${s.id}\` - since ${since}${s.label ? ` - ${s.label}` : ''}`,
      inline: false,
    };
  });

  const embed = new EmbedBuilder()
    .setTitle('Active subscriptions')
    .setColor(0x3498db)
    .addFields(...fields, buildDisclosureField())
    .setFooter(discordEmbedFooter());
  await interaction.reply({ embeds: [embed], ...ephemeral });
};

const handleHelp = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  await interaction.reply({ embeds: [buildHelpEmbed()], ...ephemeral });
};

// ---------------------------------------------------------------------------
// /pullcast optout + /pullcast optout-remove
//
// Self-service opt-out: the invoking Discord user CLAIMS ownership of the
// wallet. We do NOT verify ownership (SIWE is out of scope per architecture
// Section 9). The slash command reply documents the limitation, and the
// README points opt-out victims at the maintainer for removal in the case
// of someone opting out a wallet they do not own.
//
// Why we still ship it: the threat model treats this as an opt-out CTA, not
// an authoritative record. The indexer and the leaderboard both filter
// active OptOut rows; the few wallets that get adversarially opted-out are a
// minor support burden, vs the larger benefit of any wallet owner being able
// to self-serve removal from a public surface.
// ---------------------------------------------------------------------------

const consumeOptOutToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:optout:${userId}`, 3, 3);
};

const buildRateLimitedReplyEmbed = (): EmbedBuilder => {
  return new EmbedBuilder()
    .setTitle('Slow down please')
    .setColor(0xe67e22)
    .setDescription(
      'You have hit the /pullcast optout rate limit (3 per minute). Try again shortly.'
    )
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());
};

const handleOptOut = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const allowed = await consumeOptOutToken(interaction.user.id);
  if (!allowed) {
    await interaction.reply({
      embeds: [buildRateLimitedReplyEmbed()],
      ...ephemeral,
    });
    return;
  }

  const walletInput = interaction.options.getString('wallet', true);
  const wallet = sanitizeWallet(walletInput);
  if (wallet === null) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'Wallet must be a 0x-prefixed 40-character hex address.'
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  try {
    // Upsert: if a soft-deleted opt-out row exists, re-activate it by clearing
    // deletedAt. New rows get reason='self-service' and the invoking userId.
    await prismaQuery.optOut.upsert({
      where: { walletAddress: wallet },
      create: {
        walletAddress: wallet,
        discordUserId: interaction.user.id,
        reason: 'self-service',
      },
      update: {
        deletedAt: null,
        discordUserId: interaction.user.id,
        reason: 'self-service',
      },
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} optout upsert failed wallet=${wallet}:`, err);
    await interaction.reply({
      embeds: [
        buildErrorEmbed('Could not record opt-out. Please try again in a moment.'),
      ],
      ...ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Opt-out recorded')
    .setColor(0xe67e22)
    .setDescription(
      [
        `Opt-out recorded for \`${wallet}\`.`,
        '',
        'The indexer will no longer post share cards or list this wallet on',
        'public surfaces.',
        '',
        'Note: this is a self-service opt-out. If you do not own this wallet,',
        'the wallet owner can request removal via the README.',
      ].join('\n')
    )
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());

  await interaction.reply({ embeds: [embed], ...ephemeral });
  console.log(
    `[optout] recorded wallet=${wallet} discordUser=${interaction.user.id}`
  );
};

const handleOptOutRemove = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const allowed = await consumeOptOutToken(interaction.user.id);
  if (!allowed) {
    await interaction.reply({
      embeds: [buildRateLimitedReplyEmbed()],
      ...ephemeral,
    });
    return;
  }

  const walletInput = interaction.options.getString('wallet', true);
  const wallet = sanitizeWallet(walletInput);
  if (wallet === null) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'Wallet must be a 0x-prefixed 40-character hex address.'
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  let existing;
  try {
    existing = await prismaQuery.optOut.findFirst({
      where: { walletAddress: wallet, deletedAt: null },
      select: { id: true },
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} optout-remove lookup failed wallet=${wallet}:`, err);
    await interaction.reply({
      embeds: [
        buildErrorEmbed('Could not look up opt-out. Please try again in a moment.'),
      ],
      ...ephemeral,
    });
    return;
  }

  if (existing === null) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          `No active opt-out found for \`${wallet}\`. Nothing to remove.`
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  try {
    await prismaQuery.optOut.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} optout-remove update failed wallet=${wallet}:`, err);
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'Could not remove opt-out. Please try again in a moment.'
        ),
      ],
      ...ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Opt-out removed')
    .setColor(0x2ecc71)
    .setDescription(
      [
        `Opt-out removed for \`${wallet}\`.`,
        '',
        'Note: opt-out removal is self-service and trusts the caller\'s claim.',
        'If this wallet should not be re-exposed, contact the maintainer per',
        'the README.',
      ].join('\n')
    )
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());

  await interaction.reply({ embeds: [embed], ...ephemeral });
  console.log(
    `[optout] removed wallet=${wallet} discordUser=${interaction.user.id}`
  );
};

// ---------------------------------------------------------------------------
// Command spec
// ---------------------------------------------------------------------------

const data = new SlashCommandBuilder()
  .setName('pullcast')
  .setDescription('Subscribe this channel to Renaiss pack pulls.')
  .addSubcommand((sc) =>
    sc
      .setName('subscribe')
      .setDescription('Subscribe this channel to a wallet OR a pack.')
      .addStringOption((opt) =>
        opt
          .setName('wallet')
          .setDescription('0x-prefixed wallet address (40 hex chars).')
          .setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName('pack')
          .setDescription('Tracked pack slug (eden, omega, renacrypt).')
          .setRequired(false)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName('unsubscribe')
      .setDescription('Remove a subscription owned by this channel. Omit id to list ids.')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('Subscription id from /pullcast list.').setRequired(false)
      )
  )
  .addSubcommand((sc) =>
    sc.setName('list').setDescription('List this channel\'s active subscriptions.')
  )
  .addSubcommand((sc) =>
    sc
      .setName('optout')
      .setDescription('Self-service opt-out for a wallet (claim only, no SIWE verification).')
      .addStringOption((opt) =>
        opt
          .setName('wallet')
          .setDescription('0x-prefixed wallet address to opt out.')
          .setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName('optout-remove')
      .setDescription('Remove an existing self-service opt-out for a wallet.')
      .addStringOption((opt) =>
        opt
          .setName('wallet')
          .setDescription('0x-prefixed wallet address to un-opt-out.')
          .setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc.setName('help').setDescription('Show PullCast commands.')
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
    case 'list':
      await handleList(interaction);
      return;
    case 'optout':
      await handleOptOut(interaction);
      return;
    case 'optout-remove':
      await handleOptOutRemove(interaction);
      return;
    case 'help':
      await handleHelp(interaction);
      return;
    default:
      await interaction.reply({
        embeds: [buildErrorEmbed(`Unknown subcommand: ${sub}`)],
        ...ephemeral,
      });
  }
};

export const pullcastCommand: Command = { data, handler };


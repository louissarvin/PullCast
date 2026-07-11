/**
 * `/profile` slash command group.
 *
 * Subcommands:
 *  - user  - takes a Discord @mention and attempts to resolve them to a
 *            Renaiss UUID. Since the public Renaiss main API does not expose
 *            an address-to-UUID or Discord-to-UUID bridge (verified against
 *            live openapi.json 2026-07-02), this path currently ALWAYS returns
 *            the "not linked" helper embed. When a Discord<->Renaiss mapping
 *            table is added later, this handler is the single call site to
 *            wire it into.
 *  - uuid  - takes a raw RFC 4122 UUID and fetches the live public profile
 *            from `/v0/users/{id}`.
 *
 * Hard rules honored:
 *  - Every embed carries the disclosure footer + spacer field.
 *  - Per-user rate-limit via `consumeRateLimitToken` bucket
 *    `discord:command:profile:<userId>` (5 tokens / 5 per minute refill).
 *  - Defer BEFORE upstream call; rate-limit check happens FIRST so an
 *    exhausted user does not consume a deferred reply slot.
 *  - UUID validation is regex-guarded before the network call.
 */

import {
  APIEmbedField,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import type { Command } from '../command-registry.ts';
import { buildDisclosureField, buildErrorEmbed } from '../embed-builders.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';
import { consumeRateLimitToken } from '../../rate-limit.ts';
import { renaissApi, RenaissApiError } from '../../renaiss/index.ts';
import type { RenaissUser } from '../../renaiss/index.ts';

const LOG_PREFIX = '[profile]';

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

const consumeProfileToken = async (userId: string): Promise<boolean> => {
  return consumeRateLimitToken(`discord:command:profile:${userId}`, 5, 5);
};

const data = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('Look up a Renaiss public profile.')
  .addSubcommand((sc) =>
    sc
      .setName('user')
      .setDescription('Look up profile by Discord user (requires a linked Renaiss UUID).')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Discord user to look up.').setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName('uuid')
      .setDescription('Look up profile by raw Renaiss UUID.')
      .addStringOption((opt) =>
        opt
          .setName('value')
          .setDescription('The RFC 4122 UUID of the Renaiss user.')
          .setRequired(true)
      )
  );

const formatFmvCents = (raw: string | null | undefined): string => {
  if (typeof raw !== 'string') return '–';
  if (!/^\d+$/.test(raw)) return '–';
  const cents = Number(raw);
  if (!Number.isFinite(cents)) return '–';
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) {
    return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  return `$${dollars.toFixed(2)}`;
};

const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
};

const buildProfileEmbed = (user: RenaissUser): EmbedBuilder => {
  const embed = new EmbedBuilder()
    .setTitle(`Profile: ${user.username}`)
    .setColor(0x3498db)
    .setURL(`https://www.renaiss.xyz/users/${encodeURIComponent(user.id)}`)
    .setFooter(discordEmbedFooter());

  if (typeof user.avatarUrl === 'string' && user.avatarUrl.startsWith('https://')) {
    try {
      embed.setThumbnail(user.avatarUrl);
    } catch (err) {
      console.warn(`${LOG_PREFIX} setThumbnail rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const fields: APIEmbedField[] = [];
  fields.push({ name: 'UUID', value: `\`${user.id}\``, inline: false });

  const favs = Array.isArray(user.favoritedCollectibles)
    ? user.favoritedCollectibles
    : [];
  if (favs.length === 0) {
    fields.push({
      name: 'Favorited collectibles',
      value: 'None',
      inline: false,
    });
  } else {
    const lines = favs.slice(0, 5).map((fav) => {
      const tid = truncate(fav.tokenId ?? 'unknown', 20);
      const c = fav.collectible;
      if (!c) {
        return `• Token \`${tid}\` (unavailable)`;
      }
      const cardName =
        typeof c.item?.name === 'string' && c.item.name.length > 0
          ? c.item.name
          : 'Unknown card';
      const setName =
        typeof c.item?.setName === 'string' && c.item.setName.length > 0
          ? ` — ${c.item.setName}`
          : '';
      const grade =
        typeof c.grade === 'string' && c.grade.length > 0
          ? ` (${c.gradingCompany ?? ''} ${c.grade})`.replace(/\s+/g, ' ').trim()
          : '';
      const fmv = ` · FMV ${formatFmvCents(c.fmvPriceInUsd ?? null)}`;
      return `• ${truncate(cardName, 40)}${setName}${grade}${fmv}`;
    });
    fields.push({
      name: `Favorited collectibles (${favs.length})`,
      value: truncate(lines.join('\n'), 1020),
      inline: false,
    });
  }

  const sbts = Array.isArray(user.favoritedSBTs) ? user.favoritedSBTs : [];
  if (sbts.length > 0) {
    const lines = sbts.slice(0, 8).map((s) => `• ${truncate(s.title, 40)}`);
    fields.push({
      name: `SBT badges (${sbts.length})`,
      value: truncate(lines.join('\n'), 1020),
      inline: false,
    });
  }

  fields.push(buildDisclosureField());
  embed.addFields(fields);
  return embed;
};

const buildNotLinkedEmbed = (
  discordUsername: string
): EmbedBuilder => {
  return new EmbedBuilder()
    .setTitle('Profile not linked')
    .setColor(0xe67e22)
    .setDescription(
      `**${discordUsername}** does not have a linked Renaiss profile in PullCast.\n\n` +
        'The Renaiss main API identifies users by UUID, and there is no public ' +
        'address-to-UUID bridge. To look up a specific profile use ' +
        '`/profile uuid:<value>` with the target Renaiss UUID directly.\n\n' +
        'A Discord <-> Renaiss mapping table has not been provisioned yet; ' +
        'see PullCast roadmap.'
    )
    .addFields(buildDisclosureField())
    .setFooter(discordEmbedFooter());
};

const handleUuidSub = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const raw = interaction.options.getString('value', true);
  const trimmed = raw.trim();
  if (!UUID_RX.test(trimmed)) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'Provided value is not a valid UUID. Renaiss identifies users by UUID; wallet addresses and usernames are not accepted here.'
        ),
      ],
      ...ephemeral,
    });
    return;
  }
  const uuid = trimmed.toLowerCase();

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error(`${LOG_PREFIX} deferReply failed:`, err);
    return;
  }

  try {
    const user = await renaissApi.getUser(uuid);
    const embed = buildProfileEmbed(user);
    await interaction.editReply({ embeds: [embed] });
    console.log(
      `${LOG_PREFIX} ok uuid=${uuid} user=${interaction.user.id}`
    );
  } catch (err) {
    if (err instanceof RenaissApiError && err.status === 404) {
      await interaction.editReply({
        embeds: [
          buildErrorEmbed(
            `No Renaiss user found for UUID \`${uuid}\`.`
          ),
        ],
      });
      return;
    }
    console.error(`${LOG_PREFIX} getUser failed uuid=${uuid}:`, err);
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          'Failed to fetch profile from Renaiss main API. Please try again.'
        ),
      ],
    });
  }
};

/**
 * `/profile user:<mention>` handler.
 *
 * There is currently no stored Discord<->Renaiss UUID mapping (verified: the
 * only Discord-user linkage in the schema today is on the OptOut table, which
 * ties a wallet address to a Discord user id, and the public Renaiss main API
 * has no address-to-UUID bridge).
 *
 * This handler is intentionally the ONE call site that will need to change
 * once a mapping table lands. For now it always returns the "not linked"
 * helper embed rather than fake a lookup or crash.
 */
const handleUserSub = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const target = interaction.options.getUser('user', true);
  const embed = buildNotLinkedEmbed(target.username);
  await interaction.reply({ embeds: [embed], ...ephemeral });
  console.log(
    `${LOG_PREFIX} not-linked (no mapping table yet) target=${target.id} caller=${interaction.user.id}`
  );
};

const handler = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  // Rate-limit BEFORE deferring or replying so an exhausted user does not eat
  // a deferred reply slot.
  const allowed = await consumeProfileToken(interaction.user.id);
  if (!allowed) {
    const slowEmbed = new EmbedBuilder()
      .setTitle('Slow down please')
      .setColor(0xe67e22)
      .setDescription(
        'You have hit the /profile rate limit (5 per minute). Try again shortly.'
      )
      .addFields(buildDisclosureField())
      .setFooter(discordEmbedFooter());
    await interaction.reply({ embeds: [slowEmbed], ...ephemeral });
    return;
  }

  const sub = interaction.options.getSubcommand();
  if (sub === 'uuid') {
    await handleUuidSub(interaction);
    return;
  }
  if (sub === 'user') {
    await handleUserSub(interaction);
    return;
  }
  await interaction.reply({
    embeds: [buildErrorEmbed(`Unknown subcommand: ${sub}`)],
    ...ephemeral,
  });
};

export const profileCommand: Command = { data, handler };


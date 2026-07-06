/**
 * `/renaiss` slash command — ecosystem command reference for judges and builders.
 *
 * Lists every PullCast surface that composes Renaiss main API + OS Index API.
 * Complements `/pullcast help` (subscription commands only).
 */

import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';

import type { Command } from '../command-registry.ts';
import { buildDisclosureField } from '../embed-builders.ts';
import { discordEmbedFooter } from '../../disclosure/index.ts';

const data = new SlashCommandBuilder()
  .setName('renaiss')
  .setDescription('Renaiss ecosystem commands — Index API, marketplace, Cert Bridge.');

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const indexLines = [
    '**Renaiss OS Index (beta)**',
    '`/market [game]` — basket indices (Pokemon / One Piece / Sports)',
    '`/featured [limit]` — top movers',
    '`/trades [limit]` — live cross-market trade feed',
    '`/search query:<text>` — Index card search (min 2 chars)',
    '`/set game:<g> set:<slug>` — set listing + top cards',
    '`/price token|cert` — Cert Bridge (tokenId → Serial → Index FMV)',
    '`/valuate cert|photo` — graded lookup + photo SSE',
    '`/report` — forward data issues to Index /v1/report',
    '`/alerts subscribe` — Big Trade notifications',
  ];

  const mainLines = [
    '**Renaiss main API**',
    '`/browse` — marketplace (mirrors `npx renaiss marketplace`)',
    '`/packs [slug]` — gacha packs (mirrors `gacha list`)',
    '`/odds pack:<slug>` — empirical odds blend',
    '`/profile` — user + SBT badges',
  ];

  const collectorLines = [
    '**PullCast collector**',
    '`/pullcast subscribe` — auto-share pulls to this channel',
    '`/leaderboard daily` — Pull-of-the-Day',
    '`/explain` / `/listing` — grounded AI (Groq + citation guard)',
  ];

  const cliLines = [
    '**Terminal:** `npx pullcast` extends `npx renaiss` — `trades`, `search`, `set`, `price`, `valuate`, `market`, `featured`, `report`',
    '**Web:** pullcast.xyz — trades, search, featured, sets, Card Lens',
  ];

  const embed = new EmbedBuilder()
    .setTitle('PullCast × Renaiss ecosystem')
    .setColor(0x5865f2)
    .setDescription(
      'First community client composing Renaiss main API, OS Index API, and CLI. Read-only. Every price cites its source.'
    )
    .addFields(
      { name: 'Index API', value: indexLines.join('\n').slice(0, 1024) },
      { name: 'Main API + collector', value: [...mainLines, '', ...collectorLines].join('\n').slice(0, 1024) },
      { name: 'CLI + web', value: cliLines.join('\n').slice(0, 1024) },
      buildDisclosureField()
    )
    .setFooter(discordEmbedFooter());

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
};

export const renaissCommand: Command = { data, handler };

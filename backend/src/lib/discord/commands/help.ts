/**
 * Top-level `/help` shortcut. Mirrors `/pullcast help` so newcomers do not
 * have to remember the namespace.
 */

import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';

import type { Command } from '../command-registry.ts';
import { buildHelpEmbed } from './pullcast.ts';

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show PullCast commands.');

const handler = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  await interaction.reply({
    embeds: [buildHelpEmbed()],
    flags: MessageFlags.Ephemeral,
  });
};

export const helpCommand: Command = { data, handler };

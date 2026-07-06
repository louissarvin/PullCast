import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  Events,
  Interaction,
  MessageFlags,
  ModalSubmitInteraction,
  REST,
  Routes,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import {
  DISCORD_APP_ID,
  DISCORD_BOT_TOKEN,
  DISCORD_DEV_GUILD_ID,
} from '../../config/main-config.ts';
import { redactSecrets } from '../../utils/redactSecrets.ts';

const LOG_PREFIX = '[discord]';

/**
 * A buildable command spec + its handler. We accept the three common
 * `SlashCommandBuilder` variants (with options, with subcommands, plain) so
 * the D3-D6 command files do not have to fight the types.
 */
export type CommandBuilder =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

/**
 * Custom-id prefix router for non-chat-input interactions.
 *
 * Commands can declare `buttons: [{ prefix, handler }]` and/or
 * `modals: [{ prefix, handler }]` to opt into receiving button-click /
 * modal-submit interactions whose `customId` starts with the given prefix.
 * The prefix pattern lets a single command own a family of ids
 * (e.g. `report:cert:PSA123`, `report:token:456`).
 */
export interface ButtonRoute {
  /** customId prefix, e.g. `report:cert:`. Matched with `startsWith`. */
  prefix: string;
  handler: (interaction: ButtonInteraction) => Promise<void>;
}

export interface ModalRoute {
  /** customId prefix, e.g. `report-modal:`. Matched with `startsWith`. */
  prefix: string;
  handler: (interaction: ModalSubmitInteraction) => Promise<void>;
}

export interface Command {
  data: CommandBuilder;
  handler: (interaction: ChatInputCommandInteraction) => Promise<void>;
  /** Optional button-click routes owned by this command. */
  buttons?: ButtonRoute[];
  /** Optional modal-submit routes owned by this command. */
  modals?: ModalRoute[];
}

/**
 * Push the slash command JSON to Discord. If `DISCORD_DEV_GUILD_ID` is set we
 * register as guild commands (propagate in seconds). Otherwise we go global
 * (~1h propagation). See architecture doc Open Question 5.
 *
 * Idempotent: the underlying PUT replaces all commands for the scope, so
 * removed commands disappear and renamed commands swap cleanly.
 */
export const registerCommands = async (
  _client: Client,
  commands: Command[]
): Promise<void> => {
  if (!DISCORD_BOT_TOKEN || !DISCORD_APP_ID) {
    throw new Error(`${LOG_PREFIX} DISCORD_BOT_TOKEN and DISCORD_APP_ID are required to register commands`);
  }
  if (commands.length === 0) {
    console.warn(`${LOG_PREFIX} registerCommands called with empty list - nothing to do`);
    return;
  }

  const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
  const body = commands.map((c) => c.data.toJSON());

  const route =
    DISCORD_DEV_GUILD_ID !== null && DISCORD_DEV_GUILD_ID.length > 0
      ? Routes.applicationGuildCommands(DISCORD_APP_ID, DISCORD_DEV_GUILD_ID)
      : Routes.applicationCommands(DISCORD_APP_ID);

  const scope =
    DISCORD_DEV_GUILD_ID !== null && DISCORD_DEV_GUILD_ID.length > 0
      ? `guild=${DISCORD_DEV_GUILD_ID}`
      : 'global';

  try {
    await rest.put(route, { body });
  } catch (err) {
    // M-5: discord.js's REST rejection stringifies the full request including
    // the Authorization header. Redact before re-throwing so the boot logger
    // never sees a raw bot token.
    console.error(`${LOG_PREFIX} command registration failed: ${redactSecrets(err)}`);
    throw err instanceof Error ? err : new Error(redactSecrets(err));
  }
  console.log(`${LOG_PREFIX} registered ${commands.length} commands scope=${scope}`);
};

/**
 * Attach an `interactionCreate` listener that dispatches chat-input
 * interactions by command name. Each handler is wrapped so an uncaught throw
 * produces a generic ephemeral reply (never leaks a stack trace).
 */
export const wireCommandHandlers = (client: Client, commands: Command[]): void => {
  const byName = new Map<string, Command>();
  // Flat lookup lists for button + modal routes. Prefix matching means order
  // matters: register longest prefix first to avoid a shorter-prefix
  // shadowing (matched via linear scan below).
  const buttonRoutes: ButtonRoute[] = [];
  const modalRoutes: ModalRoute[] = [];

  for (const c of commands) {
    byName.set(c.data.name, c);
    if (Array.isArray(c.buttons)) buttonRoutes.push(...c.buttons);
    if (Array.isArray(c.modals)) modalRoutes.push(...c.modals);
  }
  // Longer prefixes first so `report:cert:` wins over `report:`.
  buttonRoutes.sort((a, b) => b.prefix.length - a.prefix.length);
  modalRoutes.sort((a, b) => b.prefix.length - a.prefix.length);

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    // -------------------------------------------------------------------
    // Chat-input command dispatch.
    // -------------------------------------------------------------------
    if (interaction.isChatInputCommand()) {
      const cmd = byName.get(interaction.commandName);
      if (!cmd) {
        console.warn(`${LOG_PREFIX} no handler registered for command=${interaction.commandName}`);
        return;
      }

      try {
        await cmd.handler(interaction);
      } catch (err) {
        console.error(
          `${LOG_PREFIX} handler error command=${interaction.commandName} user=${interaction.user.id}: ${redactSecrets(err)}`
        );
        await respondWithGenericError(interaction);
      }
      return;
    }

    // -------------------------------------------------------------------
    // Button-click dispatch. Routed by customId prefix.
    // -------------------------------------------------------------------
    if (interaction.isButton()) {
      const route = buttonRoutes.find((r) => interaction.customId.startsWith(r.prefix));
      if (!route) {
        console.warn(`${LOG_PREFIX} no button handler for customId=${interaction.customId}`);
        return;
      }
      try {
        await route.handler(interaction);
      } catch (err) {
        console.error(
          `${LOG_PREFIX} button handler error customId=${interaction.customId} user=${interaction.user.id}: ${redactSecrets(err)}`
        );
        await respondWithGenericButtonError(interaction);
      }
      return;
    }

    // -------------------------------------------------------------------
    // Modal-submit dispatch. Routed by customId prefix.
    // -------------------------------------------------------------------
    if (interaction.isModalSubmit()) {
      const route = modalRoutes.find((r) => interaction.customId.startsWith(r.prefix));
      if (!route) {
        console.warn(`${LOG_PREFIX} no modal handler for customId=${interaction.customId}`);
        return;
      }
      try {
        await route.handler(interaction);
      } catch (err) {
        console.error(
          `${LOG_PREFIX} modal handler error customId=${interaction.customId} user=${interaction.user.id}: ${redactSecrets(err)}`
        );
        await respondWithGenericModalError(interaction);
      }
      return;
    }
  });

  console.log(
    `${LOG_PREFIX} wired ${commands.length} command handlers, ${buttonRoutes.length} button routes, ${modalRoutes.length} modal routes`
  );
};

/**
 * Best-effort ephemeral "something went wrong" reply. If the interaction has
 * already been replied to we follow up; if both fail we just log.
 */
const respondWithGenericError = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const payload = {
    content: 'Something went wrong. Please try again in a moment.',
    flags: MessageFlags.Ephemeral,
  } as const;

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to send error reply: ${redactSecrets(err)}`);
  }
};

const respondWithGenericButtonError = async (
  interaction: ButtonInteraction
): Promise<void> => {
  const payload = {
    content: 'Something went wrong. Please try again in a moment.',
    flags: MessageFlags.Ephemeral,
  } as const;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to send button error reply: ${redactSecrets(err)}`);
  }
};

const respondWithGenericModalError = async (
  interaction: ModalSubmitInteraction
): Promise<void> => {
  const payload = {
    content: 'Something went wrong. Please try again in a moment.',
    flags: MessageFlags.Ephemeral,
  } as const;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to send modal error reply: ${redactSecrets(err)}`);
  }
};


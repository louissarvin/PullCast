import { Client, Events, GatewayIntentBits } from 'discord.js';
import { DISCORD_BOT_TOKEN } from '../../config/main-config.ts';
import { redactSecrets } from '../../utils/redactSecrets.ts';

const LOG_PREFIX = '[discord]';

let cached: Client | null = null;
let loginPromise: Promise<void> | null = null;

/**
 * Singleton Discord client. `GatewayIntentBits.Guilds` only - we never need
 * message content (intent gated by Discord) because all bot input arrives via
 * slash commands.
 *
 * The client is created lazily on first call. Login is a separate step via
 * `loginDiscord()` so the rest of the process can construct route plugins
 * before the Discord WebSocket comes online.
 */
export const getDiscordClient = (): Client => {
  if (cached !== null) {
    return cached;
  }

  cached = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  cached.on(Events.ClientReady, (ready) => {
    console.log(`${LOG_PREFIX} logged in as ${ready.user.tag}`);
  });

  cached.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(
      `${LOG_PREFIX} shard ${shardId} disconnected code=${event.code} reason=${event.reason}`
    );
  });

  cached.on(Events.Error, (err) => {
    // M-5: discord.js's REST client surfaces request context (incl. the
    // Authorization header carrying the bot token) on rejection. Redact
    // before printing so the shared log stream never sees the raw token.
    console.error(`${LOG_PREFIX} client error: ${redactSecrets(err)}`);
  });

  return cached;
};

/**
 * Awaits the next `ClientReady` event after initiating login. Safe to call
 * multiple times; the second call returns the same in-flight promise.
 *
 * Throws if `DISCORD_BOT_TOKEN` is missing (main-config asserts at boot, so in
 * practice this only fires in a test setup that bypassed config validation).
 */
export const loginDiscord = (): Promise<void> => {
  if (loginPromise !== null) {
    return loginPromise;
  }
  if (!DISCORD_BOT_TOKEN || DISCORD_BOT_TOKEN.length === 0) {
    return Promise.reject(new Error(`${LOG_PREFIX} DISCORD_BOT_TOKEN is not configured`));
  }

  const client = getDiscordClient();

  loginPromise = new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      client.off(Events.Error, onError);
      resolve();
    };
    const onError = (err: Error): void => {
      client.off(Events.ClientReady, onReady);
      reject(err);
    };

    client.once(Events.ClientReady, onReady);
    client.once(Events.Error, onError);

    client.login(DISCORD_BOT_TOKEN).catch((err: unknown) => {
      client.off(Events.ClientReady, onReady);
      client.off(Events.Error, onError);
      const e = err instanceof Error ? err : new Error(String(err));
      reject(e);
    });
  });

  return loginPromise;
};

/**
 * Test seam: reset the cached client. Production code never calls this.
 */
export const __resetDiscordClientForTests = (): void => {
  cached = null;
  loginPromise = null;
};

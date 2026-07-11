/**
 * GET /api/stats — adoption aggregates smoke test.
 */
import { describe, expect, test, beforeAll } from 'bun:test';

process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? 'test-token';
process.env.DISCORD_APP_ID = process.env.DISCORD_APP_ID ?? 'test-app';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY ?? 'test-groq-key';

import { buildEnvelope } from '../src/utils/envelope.ts';

describe('stats envelope shape', () => {
  test('buildEnvelope wraps stats payload with disclosure fields', () => {
    const payload = {
      cardsShared: 12,
      walletsTracked: 4,
      discordServers: 2,
      delta24h: { cardsShared: 3, walletsTracked: 1, discordServers: 1 },
    };
    const env = buildEnvelope(payload, {
      sources: [
        {
          label: 'PullCast adoption (Postgres aggregates)',
          url: 'https://pullcast.xyz/api/stats',
        },
      ],
    });
    expect(env.success).toBe(true);
    expect(env.data.cardsShared).toBe(12);
    expect(env.data.walletsTracked).toBe(4);
    expect(env.data.discordServers).toBe(2);
    expect(env.data.delta24h.cardsShared).toBe(3);
    expect(env.sources.length).toBeGreaterThan(0);
    expect(env.data._disclosure).toBeDefined();
  });
});

describe('statsRoutes module', () => {
  test('exports a Fastify plugin callback', async () => {
    const mod = await import('../src/routes/statsRoutes.ts');
    expect(typeof mod.statsRoutes).toBe('function');
  });
});

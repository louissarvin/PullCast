/**
 * Claude Code plugin marketplace route tests.
 *
 * We build a minimal Fastify instance, register only claudePluginRoutes, and
 * hit it with `.inject(...)`. This isolates the route from the rest of the
 * app boot (Discord, workers, DB) and avoids requiring the plugin file to
 * be discoverable via `process.cwd()` in the test runner.
 *
 * The marketplace.json shape matches ShipFlow's exactly:
 *   { name, owner: {name,url}, metadata: {description,version}, plugins: [...] }
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Fastify from 'fastify';

import { claudePluginRoutes } from '../src/routes/claudePluginRoutes.ts';

const buildApp = () => {
  const app = Fastify({ logger: false });
  app.register(claudePluginRoutes);
  return app;
};

describe('GET /claude-plugin/marketplace.json', () => {
  test('returns 200 with application/json content-type', async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/claude-plugin/marketplace.json',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
    } finally {
      await app.close();
    }
  });

  test('sets a Cache-Control max-age header', async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/claude-plugin/marketplace.json',
      });
      expect(res.headers['cache-control']).toContain('max-age');
    } finally {
      await app.close();
    }
  });

  test('body is valid JSON', async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/claude-plugin/marketplace.json',
      });
      // Should parse without throwing.
      const obj = JSON.parse(res.body);
      expect(typeof obj).toBe('object');
    } finally {
      await app.close();
    }
  });

  test('matches ShipFlow marketplace.json shape', async () => {
    const app = buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/claude-plugin/marketplace.json',
      });
      const obj = JSON.parse(res.body) as Record<string, unknown>;

      // Top-level required fields per ShipFlow shape.
      expect(typeof obj.name).toBe('string');
      expect(obj.name).toBe('pullcast');
      expect(typeof obj.owner).toBe('object');
      expect((obj.owner as Record<string, unknown>).name).toBeDefined();
      expect((obj.owner as Record<string, unknown>).url).toBeDefined();
      expect(typeof obj.metadata).toBe('object');
      expect((obj.metadata as Record<string, unknown>).description).toBeDefined();
      expect((obj.metadata as Record<string, unknown>).version).toBeDefined();
      expect(Array.isArray(obj.plugins)).toBe(true);
      const plugins = obj.plugins as Array<Record<string, unknown>>;
      expect(plugins.length).toBeGreaterThan(0);
      const p = plugins[0]!;
      expect(p.name).toBe('pullcast');
      expect(typeof p.description).toBe('string');
      expect(typeof p.source).toBe('object');
      const source = p.source as Record<string, unknown>;
      expect(source.source).toBe('url');
      expect(typeof source.url).toBe('string');
    } finally {
      await app.close();
    }
  });

  test('served payload matches disk marketplace.json byte-for-byte semantics', async () => {
    const diskPath = resolve(process.cwd(), 'marketplace.json');
    const disk = JSON.parse(readFileSync(diskPath, 'utf-8')) as unknown;
    const app = buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/claude-plugin/marketplace.json',
      });
      const served = JSON.parse(res.body) as unknown;
      expect(served).toEqual(disk);
    } finally {
      await app.close();
    }
  });
});

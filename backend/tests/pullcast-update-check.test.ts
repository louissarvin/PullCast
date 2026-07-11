/**
 * Tests for `cli/bin/pullcast-update-check` — the bash script that mirrors
 * ShipFlow's `shipflow-update-check`. Preamble in SKILL.md invokes it every
 * session; if it prints anything non-empty, the skill routes through
 * `references/auto-update.md`.
 *
 * The script has 4 externally observable behaviors:
 *   1. Local == latest    -> silent (exit 0, no output)
 *   2. Local  < latest    -> `UPGRADE_AVAILABLE <local> <latest>` to stdout
 *   3. PULLCAST_UPDATE_CHECK_DISABLE=1 -> silent regardless of versions
 *   4. Offline (curl fails) -> silent (never invents an answer)
 *
 * We inject the "latest" answer via PULLCAST_LATEST_OVERRIDE so tests never hit
 * npm. State dir is redirected to a tmpdir so we do not pollute ~/.pullcast/.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = join(
  fileURLToPath(new URL('..', import.meta.url)),
  'cli',
  'bin',
  'pullcast-update-check'
);
const PLUGIN_DIR = join(
  fileURLToPath(new URL('..', import.meta.url)),
  'cli'
);

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'pullcast-uc-'));
});

afterEach(() => {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const runScript = (
  env: Record<string, string> = {}
): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync('bash', [SCRIPT_PATH], {
    env: {
      ...process.env,
      PULLCAST_PLUGIN_DIR: PLUGIN_DIR,
      PULLCAST_STATE_DIR: stateDir,
      ...env,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
};

describe('pullcast-update-check', () => {
  test('silent when local version equals published version', () => {
    // cli/package.json currently pins 0.0.1 — override to the same value.
    const r = runScript({ PULLCAST_LATEST_OVERRIDE: '0.0.1' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('emits UPGRADE_AVAILABLE <local> <published> when a newer version is on npm', () => {
    const r = runScript({ PULLCAST_LATEST_OVERRIDE: '0.99.0' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('UPGRADE_AVAILABLE 0.0.1 0.99.0');
  });

  test('silent when the override reports an older version (never downgrades)', () => {
    // If someone republished with a lower version, we must not print UPGRADE.
    const r = runScript({ PULLCAST_LATEST_OVERRIDE: '0.0.0' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('respects PULLCAST_UPDATE_CHECK_DISABLE=1 (silent regardless)', () => {
    const r = runScript({
      PULLCAST_UPDATE_CHECK_DISABLE: '1',
      PULLCAST_LATEST_OVERRIDE: '99.99.99',
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('silent when curl fails (offline)', () => {
    // Point at a bogus URL and skip the override so the curl path is exercised.
    const r = runScript({
      PULLCAST_REMOTE_URL: 'https://127.0.0.1:1/pullcast',
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});

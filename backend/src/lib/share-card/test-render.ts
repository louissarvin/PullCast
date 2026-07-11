/**
 * D3 visual QA. Renders 4 sample share cards (PSA / BGS / CGC / generic) using
 * hardcoded ShareCardInput mocks and writes each PNG to ./tmp/.
 *
 * Run with: `bun run test:share-card`
 *
 * This is NOT a test-framework test; it is a deterministic CLI smoke that lets
 * the operator eyeball the output. Exits non-zero if any render fails.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { renderShareCard } from './render.ts';
import type { ShareCardInput, ShareCardStyleVariant } from './types.ts';

const LOG_PREFIX = '[share-card][test]';

// A real Renaiss-served Mickey Mantle PSA image, used so all four sample
// renders exercise the full fetch -> data-url -> Satori path. The renderer's
// fallback handles the case where the URL is unreachable.
const SAMPLE_IMAGE_URL =
  'https://placehold.co/600x840/0B0F19/F9FAFB.png?text=Card';

interface Sample {
  label: string;
  variant: ShareCardStyleVariant;
  input: ShareCardInput;
}

const baseDate = new Date('2026-07-06T15:42:00Z');

const SAMPLES: Sample[] = [
  {
    label: 'psa',
    variant: 'psa',
    input: {
      cardName: '1952 Mickey Mantle',
      setName: 'Topps',
      cardNumber: '311',
      imageUrl: SAMPLE_IMAGE_URL,
      packLabel: 'Eden Pack',
      packPriceUsdCents: 9900,
      fmvUsdCents: 12_500_000, // $125,000.00
      netGainUsdCents: 12_490_100,
      gradingCompany: 'PSA',
      grade: '9',
      serial: 'PSA73628064',
      buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      pulledAt: baseDate,
      tier: 'legendary',
      styleVariant: 'psa',
    },
  },
  {
    label: 'bgs',
    variant: 'bgs',
    input: {
      cardName: '1986 Michael Jordan Fleer Rookie',
      setName: 'Fleer Basketball',
      cardNumber: '57',
      imageUrl: SAMPLE_IMAGE_URL,
      packLabel: 'OMEGA',
      packPriceUsdCents: 29900,
      fmvUsdCents: 850_000,
      netGainUsdCents: 820_100,
      gradingCompany: 'BGS',
      grade: '9.5',
      serial: 'BGS0014998877',
      buyerAddress: '0xabcdef0123456789abcdef0123456789abcdef01',
      pulledAt: baseDate,
      tier: 'epic',
      styleVariant: 'bgs',
    },
  },
  {
    label: 'cgc',
    variant: 'cgc',
    input: {
      cardName: 'Charizard Holo Base Set',
      setName: 'Pokemon Base Set',
      cardNumber: '4/102',
      imageUrl: SAMPLE_IMAGE_URL,
      packLabel: 'RenaCrypt',
      packPriceUsdCents: 4999,
      fmvUsdCents: 380_000,
      netGainUsdCents: 375_001,
      gradingCompany: 'CGC',
      grade: '9.5',
      serial: 'CGC4321098765',
      buyerAddress: '0xdeadbeef0000000000000000000000000000beef',
      pulledAt: baseDate,
      tier: 'rare',
      styleVariant: 'cgc',
    },
  },
  {
    label: 'generic',
    variant: 'generic',
    input: {
      cardName: 'Random Common Card',
      setName: 'Set 2026',
      cardNumber: '042',
      imageUrl: SAMPLE_IMAGE_URL,
      packLabel: 'Eden Pack',
      packPriceUsdCents: 9900,
      fmvUsdCents: 7500,
      netGainUsdCents: -2400,
      gradingCompany: null,
      grade: null,
      serial: null,
      buyerAddress: '0x0000000000000000000000000000000000000abc',
      pulledAt: baseDate,
      tier: 'common',
      styleVariant: 'generic',
    },
  },
];

const main = async (): Promise<void> => {
  const outDir = resolve(process.cwd(), 'tmp');
  await mkdir(outDir, { recursive: true });

  const results: Array<{ label: string; path: string; ms: number; bytes: number }> = [];
  let anyFailed = false;

  for (const sample of SAMPLES) {
    const t0 = performance.now();
    try {
      const card = await renderShareCard(sample.input);
      const outPath = resolve(outDir, `share-card-test-${sample.label}.png`);
      await writeFile(outPath, card.png);
      const ms = Math.round(performance.now() - t0);
      results.push({ label: sample.label, path: outPath, ms, bytes: card.byteSize });
      console.log(`${LOG_PREFIX} ${sample.label} -> ${outPath} (${card.byteSize} bytes, ${ms}ms total)`);
    } catch (err) {
      anyFailed = true;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} ${sample.label} FAILED: ${reason}`);
    }
  }

  console.log(`${LOG_PREFIX} done. ${results.length}/${SAMPLES.length} rendered.`);
  for (const r of results) {
    console.log(`${LOG_PREFIX}   ${r.label}: ${r.path}`);
  }

  if (anyFailed) {
    process.exitCode = 1;
  }
};

main().catch((err) => {
  console.error(`${LOG_PREFIX} fatal:`, err);
  process.exit(1);
});

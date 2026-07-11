/**
 * Centralized mapping from a Prisma `Pull` row to the renderer's
 * `ShareCardInput` shape.
 *
 * Keeping this in one place means: (a) the renderer stays Prisma-free per D3,
 * and (b) every caller (indexer poster, OG route, manual reprocess scripts)
 * normalizes the same way. If the Pull schema evolves, the mapping changes
 * here only.
 */

import type { Pull } from '../../../prisma/generated/client.js';
import type { ShareCardInput } from './types.ts';

const LOG_PREFIX = '[share-card]';

const PACK_LABELS: Record<string, string> = {
  'eden': 'Eden Pack',
  'eden-pack': 'Eden Pack',
  'omega': 'OMEGA',
  'renacrypt': 'RenaCrypt',
  'renacrypt-pack': 'RenaCrypt',
};

const packLabelFor = (slug: string): string => {
  if (typeof slug !== 'string' || slug.length === 0) {
    return 'Unknown Pack';
  }
  const known = PACK_LABELS[slug.toLowerCase()];
  if (known) return known;
  // Fallback: title-case the slug, swapping hyphens for spaces.
  return slug
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
};

const normalizeGrader = (
  raw: string | null
): 'PSA' | 'BGS' | 'CGC' | 'SGC' | null => {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (upper === 'PSA' || upper === 'BGS' || upper === 'CGC' || upper === 'SGC') {
    return upper;
  }
  return null;
};

/**
 * Map a Prisma Pull row to ShareCardInput. Performs no I/O, no DB calls; the
 * caller is responsible for ensuring the row is non-null and not soft-deleted.
 *
 * Fallbacks:
 *  - cardName: `cardName ?? setName ?? "Pull #<short id>"`
 *  - imageUrl: `frontImageUrl ?? ''` (renderer falls back to transparent pixel)
 *  - pulledAt: clones the DB DateTime so the renderer cannot mutate it
 */
export const extractShareCardInputFromPull = (pull: Pull): ShareCardInput => {
  const cardName =
    typeof pull.cardName === 'string' && pull.cardName.length > 0
      ? pull.cardName
      : typeof pull.setName === 'string' && pull.setName.length > 0
        ? pull.setName
        : `Pull #${pull.id.slice(0, 8)}`;

  const grader = normalizeGrader(pull.gradingCompany);

  const input: ShareCardInput = {
    cardName,
    setName: pull.setName ?? undefined,
    cardNumber: pull.cardNumber ?? undefined,
    imageUrl:
      typeof pull.frontImageUrl === 'string' && pull.frontImageUrl.length > 0
        ? pull.frontImageUrl
        : '',
    packLabel: packLabelFor(pull.packSlug),
    packPriceUsdCents: pull.packPriceUsdCents,
    fmvUsdCents: pull.fmvUsdCents,
    netGainUsdCents: pull.netGainUsdCents,
    gradingCompany: grader,
    grade: pull.grade ?? null,
    serial: pull.serial ?? null,
    buyerAddress: pull.buyerAddress,
    pulledAt: new Date(pull.pulledAtTimestamp),
    tier: pull.tier ?? null,
  };

  if (input.imageUrl.length === 0) {
    console.warn(`${LOG_PREFIX} pull=${pull.id} has no frontImageUrl, using placeholder render`);
  }

  return input;
};

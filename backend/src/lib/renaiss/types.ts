/**
 * Types for the Renaiss main API (api.renaiss.xyz/v0).
 *
 * As of D2, all types are inferred from the zod schemas in `schemas.ts` so the
 * runtime validators and TS types cannot drift.
 *
 * IMPORTANT: the main API returns USD price fields as STRING cents (e.g. "7350"
 * means $73.50), while the Renaiss Index API (api.renaissos.com/v1) returns
 * INTEGER cents. All consumers MUST go through `parsePriceCents` before doing
 * math on these values.
 */

export type {
  RenaissPack,
  RenaissPull,
  RenaissCard,
  RenaissListing,
  RenaissListingsResponse,
  RenaissUser,
  RenaissUserFavoritedCollectible,
  RenaissUserSbt,
} from './schemas.ts';

/**
 * Normalize a price field that may arrive as a string (main API), a number
 * (Index API), or null/undefined.
 *
 * Returns integer cents on success, or null if the value is missing or
 * unparseable. Never throws so the caller never crashes a route on bad data
 * from upstream.
 */
export const parsePriceCents = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.trunc(value);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Reject anything that is not a pure integer string. We intentionally do not
  // accept decimals here: upstream is documented as integer cents.
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
};

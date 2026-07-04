/**
 * D9: Renaiss item id (rid) extraction from a canonical Renaiss main API card.
 *
 * The Renaiss OS Index API exposes a family of `by-renaiss-id/{rid}` endpoints
 * (rid = upstream `items.renaiss_item_id`, a UUID such as
 * `12670e6b-f07a-4a56-bc37-4f5e42edc6a8`). If we can extract a rid from a Pull
 * we index, we can widen the Index-API bridge from graded-cert-only to ANY
 * Renaiss collectible.
 *
 * ---
 * Live verification 2026-07-03 — findings from inspecting real endpoints:
 *
 * 1. `/v0/marketplace` collection items (top-level keys):
 *      askPriceInUSDT, attributes, cardNumber, fmvPriceInUSD, grade,
 *      gradingCompany, name, owner, ownerAddress, pokemonName, setName,
 *      tokenId, vaultLocation, year
 *    NO `renaissId`, `renaissItemId`, `rid`, `id`, `itemId`, or `catalogId`.
 *
 * 2. `attributes[]` on 10 sampled marketplace items only ever contains
 *      { trait: "Serial", value: "PSA...|CGC..." } and
 *      { trait: "Language", value: "English|Japanese" }
 *    NO rid attribute.
 *
 * 3. `/v0/cards/{tokenId}` (main API) currently returns
 *      { error: "Failed to get collectible", code: "COLLECTIBLE_GET_FAILED" }
 *    for every real tokenId we tested (three consecutive marketplace items).
 *    Endpoint appears broken upstream; even if it worked, its schema (see
 *    `src/lib/renaiss/schemas.ts`) does not contain a rid field.
 *
 * 4. `imageUrl` on marketplace items points to a Vercel blob path that embeds
 *    the CERT SERIAL, not a rid, e.g.
 *      https://.../inventory/graded/PSA120383833/item.webp
 *    So the imageUrl-parse extraction path yields the SAME data as the
 *    cert-serial path — it does not unlock non-graded coverage.
 *
 * 5. `/v1/graded/{cert}` (Index API) returns `card.href` slug that ends with
 *    the FIRST 8 chars of the Index-API cardId (a *different* UUID from rid),
 *    e.g. `-1ac559f4`. This is the Index `items.id`, not `renaiss_item_id`.
 *    A prefix does not uniquely resolve to a full UUID and there is no
 *    documented bridge from `items.id` to `renaiss_item_id` in the OpenAPI.
 *
 * Conclusion: NO rid extraction path exists today from a Renaiss BSC tokenId
 * or main-API card response. The functions in this file therefore return
 * `null` for every real input, and the card-bridge falls back to the cert-
 * serial path which does work (see `card-bridge.ts`).
 *
 * When Renaiss main API adds a `renaissItemId` (or equivalent) to
 * `/v0/cards/{tokenId}` or the marketplace item shape, drop the rid extractor
 * into `extractRenaissIdFromCard` below and the card-bridge's rid-first
 * priority order will start firing without any other code change.
 * ---
 */

import type { CanonicalRenaissCard } from '../renaiss/schemas.ts';

const LOG_PREFIX = '[rid-bridge]';

export type RidExtractionMethod =
  | 'direct-field'
  | 'attribute'
  | 'imageUrl-parse'
  | 'passthrough';

export interface RidExtractionResult {
  rid: string | null;
  method: RidExtractionMethod | null;
}

// UUID v4 (or any-version) regex: 8-4-4-4-12 hex with hyphens. Used to validate
// that whatever we pull out actually looks like the shape `items.renaiss_item_id`
// takes (verified against `/v1/openapi.json` example
// `12670e6b-f07a-4a56-bc37-4f5e42edc6a8`).
const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && UUID_RX.test(v);

/**
 * Read `card.attributes[].value` where `trait_type` (post-normalization) is
 * one of the rid-shaped aliases. Case-insensitive; tolerates trailing whitespace.
 *
 * All shipped upstream schemas today expose Serial + Language only, so this
 * returns null in every real live case. It exists so that when Renaiss adds an
 * attribute like `{ trait: "RenaissId", value: "<uuid>" }` we start using it
 * immediately without a code change.
 */
const extractFromAttributes = (card: CanonicalRenaissCard): string | null => {
  if (!Array.isArray(card.attributes)) return null;
  for (const attr of card.attributes) {
    if (typeof attr !== 'object' || attr === null) continue;
    const t = (attr as { trait_type?: unknown }).trait_type;
    if (typeof t !== 'string') continue;
    const lower = t.trim().toLowerCase();
    const isRidKey =
      lower === 'rid' ||
      lower === 'renaissid' ||
      lower === 'renaiss id' ||
      lower === 'renaissitemid' ||
      lower === 'renaiss item id' ||
      lower === 'itemid' ||
      lower === 'catalogid' ||
      lower === 'catalog id';
    if (!isRidKey) continue;
    const v = (attr as { value?: unknown }).value;
    if (isUuid(v)) return v;
    if (typeof v === 'string' && v.length > 0) {
      // Non-UUID form (e.g. slug). Still return so downstream can try it; the
      // Index API will 404 on a bad rid and the bridge will fall back.
      return v.trim();
    }
  }
  return null;
};

/**
 * Read a direct field on the normalized card. Every candidate field is checked
 * against the UUID shape before being returned so we don't emit noise (e.g.
 * `card.name` matching a coincidental key).
 */
const extractFromDirectField = (
  card: CanonicalRenaissCard
): string | null => {
  const bag = card as unknown as Record<string, unknown>;
  const candidates = [
    'renaissItemId',
    'renaiss_item_id',
    'renaissId',
    'rid',
    'itemId',
    'catalogId',
    'internalId',
  ] as const;
  for (const key of candidates) {
    const v = bag[key];
    if (isUuid(v)) return v;
  }
  return null;
};

/**
 * Try to parse a rid from a Vercel blob storage image URL. Live URLs are of the
 * form:
 *   https://<blob>.public.blob.vercel-storage.com/inventory/graded/PSA<cert>/item.webp
 * and embed the CERT SERIAL, not a rid. This function looks for a UUID-shaped
 * path segment as future-proofing (in case upstream ever adds one) and returns
 * null on every current live URL.
 */
const extractFromImageUrl = (card: CanonicalRenaissCard): string | null => {
  const url =
    card.imageUrl ??
    card.frontImageUrl ??
    card.frontWithoutStandImageUrl ??
    null;
  if (typeof url !== 'string' || url.length === 0) return null;
  // Match any UUID-shaped path segment.
  const m = url.match(
    /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|\?|$)/i
  );
  return m ? m[1] : null;
};

/**
 * Extract a Renaiss item id (rid) from a canonical main-API card.
 *
 * Returns `{ rid, method }` where `method` names which extraction path fired.
 * The method label is written to logs on the calling side so we can measure
 * live-coverage percentages over time.
 *
 * NOTE: today every extractor returns null against real live shapes; see the
 * top-of-file rationale. This function is safe to call and idempotent; it
 * makes no network requests.
 */
export const extractRenaissIdFromCard = (
  card: CanonicalRenaissCard | null | undefined
): RidExtractionResult => {
  if (card === null || card === undefined) {
    return { rid: null, method: null };
  }

  const direct = extractFromDirectField(card);
  if (direct !== null) {
    console.log(`${LOG_PREFIX} extracted rid=${direct} method=direct-field`);
    return { rid: direct, method: 'direct-field' };
  }

  const fromAttrs = extractFromAttributes(card);
  if (fromAttrs !== null) {
    console.log(`${LOG_PREFIX} extracted rid=${fromAttrs} method=attribute`);
    return { rid: fromAttrs, method: 'attribute' };
  }

  const fromImage = extractFromImageUrl(card);
  if (fromImage !== null) {
    console.log(`${LOG_PREFIX} extracted rid=${fromImage} method=imageUrl-parse`);
    return { rid: fromImage, method: 'imageUrl-parse' };
  }

  return { rid: null, method: null };
};

/**
 * Convenience: check whether a raw string looks like a valid rid without
 * triggering an HTTP request. Route validators use this to 400 obvious bad
 * inputs before consuming the shared per-IP rate limit budget.
 */
export const isValidRid = (raw: unknown): raw is string => isUuid(raw);

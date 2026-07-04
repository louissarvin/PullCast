/**
 * Runtime zod schemas for the Renaiss main API (api.renaiss.xyz/v0).
 *
 * Every HTTP response from `client.ts` is now parsed through one of these
 * schemas before being returned. Parse failures throw `RenaissApiError` with
 * the ZodError attached as `cause`.
 *
 * Upstream is documented as evolving; schemas are intentionally PERMISSIVE
 * (most fields optional, `passthrough` lets unknown keys survive) so a benign
 * upstream addition does not break the indexer mid-build week. We tighten by
 * D6 once the AI commands depend on specific fields.
 */

import { z } from 'zod';

/**
 * Price field that may arrive as a string (main API style), a number, or null.
 * Downstream consumers MUST funnel through `parsePriceCents` before arithmetic.
 */
const priceFieldSchema = z.union([z.string(), z.number(), z.null()]).optional();

/**
 * `pulledAtTimestamp` drift: earlier versions of the main API returned an ISO
 * string, the current live shape (2026-07-02) returns a NUMBER (unix seconds).
 * We accept BOTH at the boundary and transform to a canonical ISO string so
 * every downstream consumer can `Date.parse(pulledAtTimestamp)` uniformly.
 *
 * Values are treated as unix seconds when < 1e12, unix ms otherwise. Bad
 * inputs are dropped to '' and the downstream normalizer treats an
 * unparseable date as "skip this pull" (see indexer normalizePull).
 */
const timestampFieldSchema = z
  .union([z.string(), z.number()])
  .transform((v) => {
    if (typeof v === 'string') {
      // Already ISO or another Date.parse-able string. Pass through.
      return v;
    }
    if (!Number.isFinite(v)) return '';
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  });

/**
 * Raw pull entry. The schema PARSES both string and numeric `pulledAtTimestamp`
 * shapes and NORMALIZES both to an ISO string so every downstream consumer
 * (indexer, odds, share-card) can call `Date.parse(...)` uniformly.
 */
export const renaissPullSchema = z
  .object({
    collectibleTokenId: z.string(),
    tier: z.union([z.string(), z.null()]).optional(),
    fmv: priceFieldSchema,
    fmvPriceInUSD: priceFieldSchema,
    pulledAtTimestamp: timestampFieldSchema,
    buyerAddress: z.string().optional(),
    txHash: z.string().optional(),
    blockNumber: z.number().optional(),
  })
  .passthrough();

/**
 * Canonical (post-parse) pack fields. Both the root-level and the
 * `cardPack`-wrapped upstream shapes are normalized into this shape by
 * `renaissPackSchema` below.
 */
const renaissPackInnerSchema = z
  .object({
    slug: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    packPriceInUSD: priceFieldSchema,
    // Live 2026-07-02 shape uses `priceInUsdt` (string wei) instead of
    // `packPriceInUSD`. Downstream falls back to this when packPriceInUSD is
    // absent.
    priceInUsdt: priceFieldSchema,
    status: z.string().optional(),
    imageUrl: z.string().optional(),
    recentOpenedPacks: z.array(renaissPullSchema).optional(),
  })
  .passthrough();

/**
 * Shape-tolerant pack schema.
 *
 * The `/v0/packs/{slug}` endpoint has TWO known shapes in the wild:
 *  - LEGACY: root-level fields.
 *      { slug, packPriceInUSD, recentOpenedPacks: [...] }
 *  - CURRENT (2026-07-02): everything wrapped under `cardPack`.
 *      { cardPack: { slug, priceInUsdt, recentOpenedPacks: [...] } }
 *
 * `.transform()` peels off the wrapper if present and returns the canonical
 * `RenaissPack` shape plus a `_shapeVariant` discriminator so the indexer can
 * log which variant it observed on every poll (drift-detection heuristic).
 *
 * `recentOpenedPacks` is left optional so a pack with an empty rolling window
 * does not crash the parser.
 */
export const renaissPackSchema = z
  .union([
    z
      .object({
        cardPack: renaissPackInnerSchema,
      })
      .passthrough()
      .transform((raw) => ({
        ...raw.cardPack,
        _shapeVariant: 'cardPack-wrapped' as const,
      })),
    renaissPackInnerSchema.transform((raw) => ({
      ...raw,
      _shapeVariant: 'root-level' as const,
    })),
  ]);

/**
 * List-endpoint pack summary (`GET /v0/packs`).
 *
 * Verified against live openapi (2026-07-03) at `https://api.renaiss.xyz/openapi.json`.
 * The endpoint returns `{ cardPacks: [...] }` where each item carries public
 * metadata WITHOUT the `recentOpenedPacks` window (the single-slug endpoint
 * remains the source for that).
 *
 * NOTE: the openapi contract lists `priceInUsdt`, `expectedValueInUsd`,
 * `featuredCardFmvInUsd` as required strings with `pattern: ^d+$`. Live traffic
 * ships them as digit strings but we keep the schema permissive so a stray
 * `null` (openapi has `nullable: true` on the value fields) does not brick
 * the list. No image URLs are surfaced by the list endpoint today; consumers
 * (Discord embed, CLI) render text-only.
 */
export const renaissPackListItemSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    packType: z.string(),
    stage: z.string(),
    description: z.union([z.string(), z.null()]).optional(),
    author: z.string().optional(),
    priceInUsdt: z.union([z.string(), z.number(), z.null()]).optional(),
    expectedValueInUsd: z.union([z.string(), z.number(), z.null()]).optional(),
    featuredCardFmvInUsd: z.union([z.string(), z.number(), z.null()]).optional(),
  })
  .passthrough();

export const renaissPacksListResponseSchema = z
  .object({
    cardPacks: z.array(renaissPackListItemSchema),
  })
  .passthrough();

export type RenaissPackListItem = z.infer<typeof renaissPackListItemSchema>;
export type RenaissPacksListResponse = z.infer<typeof renaissPacksListResponseSchema>;

/**
 * Canonical (post-parse) card fields. Every consumer of `renaissApi.getCard`
 * (D8: `price.ts`, `listing.ts`, `explain.ts`, `retriever.ts`, `priceRoutes.ts`)
 * accesses these fields at the ROOT of the parsed value. The transform below
 * peels the live wrapped shape and re-normalizes it to this canonical form so
 * downstream call sites do not care which upstream shape produced the data.
 *
 * `attributes[]` is normalized to `{ trait_type, value }` because every
 * consumer currently greps for `trait_type` (the legacy field name). The live
 * wrapped upstream ships `{ trait, value }`; the transform renames.
 *
 * NOTE: `passthrough()` is preserved via a manual copy in the transform so
 * unknown fields (e.g. a future `promoBadge`) still survive to the caller.
 */
const renaissCardAttributeCanonicalSchema = z
  .object({
    trait_type: z.string(),
    value: z.union([z.string(), z.number()]),
  })
  .passthrough();

/**
 * Legacy (pre-drift) root-level card shape. Every field is optional except
 * `tokenId` so a lightweight upstream response (freshly-minted, sparse
 * metadata) still parses. Downstream funnels through `parsePriceCents` before
 * arithmetic on `fmvPriceInUSD`.
 */
const renaissCardLegacyShape = z
  .object({
    tokenId: z.string(),
    name: z.string().optional(),
    setName: z.string().optional(),
    cardNumber: z.string().optional(),
    imageUrl: z.string().optional(),
    frontImageUrl: z.string().optional(),
    backImageUrl: z.string().optional(),
    frontWithoutStandImageUrl: z.string().optional(),
    gradingCompany: z.string().optional(),
    grade: z.string().optional(),
    serial: z.string().optional(),
    pokemonName: z.string().optional(),
    ownerAddress: z.string().optional(),
    vaultLocation: z.string().optional(),
    year: z.number().optional(),
    attributes: z.array(renaissCardAttributeCanonicalSchema).optional(),
    fmvPriceInUSD: priceFieldSchema,
    askPriceInUSDT: priceFieldSchema,
    askExpiresAt: z.string().optional(),
  })
  .passthrough();

/**
 * Wrapped (live 2026-07-02) card shape from GET /v0/cards/{tokenId}.
 * Verified against `https://api.renaiss.xyz/openapi.json`:
 *   {
 *     collectible: { tokenId, name, setName, cardNumber, pokemonName,
 *                    ownerAddress, askPriceInUSDT, askExpiresAt,
 *                    fmvPriceInUSD, frontImageUrl, backImageUrl,
 *                    frontWithoutStandImageUrl, attributes: [{trait, value}],
 *                    vaultLocation, gradingCompany, grade, year,
 *                    custodyProvider, ownerAcquiredAt, type, owner },
 *     pricing?: { price, top_offer, last_sale, price_history?, offers? },
 *     activities?: { activities: [...] } | null
 *   }
 *
 * Every inner field is `.optional()` where the openapi contract allows null or
 * absent values, and `passthrough()` is on every layer so an additive upstream
 * change (e.g. a new `promoBadge`) does not blow up the schema. `attributes[]`
 * items here use the LIVE `{ trait, value }` shape; the transform below
 * renames `trait -> trait_type` so downstream `trait_type` code paths keep
 * working.
 */
const renaissCardWrappedAttributeSchema = z
  .object({
    trait: z.string(),
    value: z.union([z.string(), z.number()]),
  })
  .passthrough();

const renaissCardCollectibleSchema = z
  .object({
    tokenId: z.string(),
    name: z.string().optional(),
    setName: z.string().optional(),
    cardNumber: z.string().optional(),
    pokemonName: z.string().optional(),
    ownerAddress: z.string().optional(),
    askPriceInUSDT: priceFieldSchema,
    askExpiresAt: z.string().optional(),
    fmvPriceInUSD: priceFieldSchema,
    frontImageUrl: z.string().optional(),
    backImageUrl: z.string().optional(),
    frontWithoutStandImageUrl: z.string().optional(),
    attributes: z.array(renaissCardWrappedAttributeSchema).optional(),
    vaultLocation: z.string().optional(),
    gradingCompany: z.string().optional(),
    grade: z.string().optional(),
    year: z.number().optional(),
    ownerAcquiredAt: z.string().optional(),
    type: z.string().optional(),
    // `owner` may be null (per openapi `nullable: true`).
    owner: z
      .union([
        z
          .object({
            id: z.string().optional(),
            username: z.string().optional(),
          })
          .passthrough(),
        z.null(),
      ])
      .optional(),
    custodyProvider: z
      .object({
        id: z.string().optional(),
        businessName: z.string().optional(),
        countryCode: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const renaissCardPriceAmountSchema = z
  .object({
    value: z.string(),
    token: z.string(),
  })
  .passthrough();

const renaissCardPricingSchema = z
  .object({
    price: z.union([renaissCardPriceAmountSchema, z.null()]).optional(),
    top_offer: z.union([renaissCardPriceAmountSchema, z.null()]).optional(),
    last_sale: z.union([renaissCardPriceAmountSchema, z.null()]).optional(),
    price_history: z.array(z.unknown()).optional(),
    offers: z.array(z.unknown()).optional(),
  })
  .passthrough();

const renaissCardActivitiesSchema = z
  .union([
    z
      .object({
        activities: z.array(z.unknown()).optional(),
      })
      .passthrough(),
    z.null(),
  ])
  .optional();

const renaissCardWrappedShape = z
  .object({
    collectible: renaissCardCollectibleSchema,
    pricing: renaissCardPricingSchema.optional(),
    activities: renaissCardActivitiesSchema,
  })
  .passthrough();

/**
 * Post-transform canonical card. Every consumer of `renaissApi.getCard` reads
 * these at the ROOT of the parsed value. Two extras (`_shapeVariant`,
 * `pricing`, `activities`) are attached only in the wrapped-shape path so
 * observability + future consumers can access richer metadata without having
 * to guess.
 */
export interface CanonicalRenaissCard {
  tokenId: string;
  name?: string;
  setName?: string;
  cardNumber?: string;
  pokemonName?: string;
  ownerAddress?: string;
  askPriceInUSDT?: string | number | null;
  askExpiresAt?: string;
  fmvPriceInUSD?: string | number | null;
  frontImageUrl?: string;
  backImageUrl?: string;
  frontWithoutStandImageUrl?: string;
  /**
   * Legacy alias for `frontImageUrl` — every existing caller reads `imageUrl`,
   * so we mirror the front image (or fall back to the passthrough field) into
   * this key inside the transform.
   */
  imageUrl?: string;
  gradingCompany?: string;
  grade?: string;
  serial?: string;
  year?: number;
  vaultLocation?: string;
  attributes?: Array<{ trait_type: string; value: string | number }>;
  // Wrapped-only extras (surfaced for future consumers; existing callers ignore).
  pricing?: unknown;
  activities?: unknown;
  owner?: unknown;
  custodyProvider?: unknown;
  ownerAcquiredAt?: string;
  type?: string;
  _shapeVariant: 'wrapped' | 'legacy';
}

/**
 * Shape-tolerant card schema.
 *
 * The `/v0/cards/{tokenId}` endpoint has TWO known shapes:
 *  - LEGACY (pre-2026-07): flat root-level card fields.
 *      { tokenId, name, setName, fmvPriceInUSD, attributes: [{trait_type, value}], ... }
 *  - CURRENT (live 2026-07-02, per api.renaiss.xyz/openapi.json): everything
 *    wrapped under `collectible`, with `pricing` + `activities` siblings.
 *      { collectible: { tokenId, name, ..., attributes: [{trait, value}] },
 *        pricing: {...}, activities: {...} | null }
 *
 * The `.transform()` step below normalizes both variants into the same
 * `CanonicalRenaissCard` shape so downstream code (price.ts, listing.ts,
 * explain.ts, retriever.ts, priceRoutes.ts) can read `.name`, `.setName`,
 * `.fmvPriceInUSD`, `.imageUrl`, `.attributes[*].trait_type`, etc. at the
 * ROOT without knowing which variant produced the data.
 *
 * A `_shapeVariant` discriminator is attached for observability. `client.ts`
 * logs it on every parse so drift can be detected in the field.
 *
 * Order in the union matters: wrapped shape is checked FIRST because a
 * legacy-looking payload could accidentally match the wrapped shape if
 * `collectible` were a coincidence key. The wrapped inner schema requires
 * `collectible.tokenId: string` so this ordering is safe.
 */
export const renaissCardSchema: z.ZodType<CanonicalRenaissCard> = z
  .union([
    renaissCardWrappedShape.transform((raw): CanonicalRenaissCard => {
      const inner = raw.collectible;
      const attrs = Array.isArray(inner.attributes)
        ? inner.attributes.map((a) => ({
            // Live upstream ships `{ trait, value }`; existing callers read
            // `trait_type`. Rename here so downstream code does not need to
            // learn the wrapped shape.
            trait_type: a.trait,
            value: a.value,
          }))
        : undefined;
      const imageUrl = inner.frontImageUrl ?? inner.frontWithoutStandImageUrl;
      return {
        tokenId: inner.tokenId,
        name: inner.name,
        setName: inner.setName,
        cardNumber: inner.cardNumber,
        pokemonName: inner.pokemonName,
        ownerAddress: inner.ownerAddress,
        askPriceInUSDT: inner.askPriceInUSDT,
        askExpiresAt: inner.askExpiresAt,
        fmvPriceInUSD: inner.fmvPriceInUSD,
        frontImageUrl: inner.frontImageUrl,
        backImageUrl: inner.backImageUrl,
        frontWithoutStandImageUrl: inner.frontWithoutStandImageUrl,
        imageUrl,
        gradingCompany: inner.gradingCompany,
        grade: inner.grade,
        year: inner.year,
        vaultLocation: inner.vaultLocation,
        attributes: attrs,
        owner: inner.owner ?? undefined,
        custodyProvider: inner.custodyProvider,
        ownerAcquiredAt: inner.ownerAcquiredAt,
        type: inner.type,
        pricing: raw.pricing,
        activities: raw.activities ?? undefined,
        _shapeVariant: 'wrapped',
      };
    }),
    renaissCardLegacyShape.transform((raw): CanonicalRenaissCard => {
      // Legacy attributes are ALREADY in `{ trait_type, value }` shape; no
      // rename needed. Copy through so passthrough extras survive.
      const attrs = Array.isArray(raw.attributes)
        ? raw.attributes.map((a) => ({
            trait_type: a.trait_type,
            value: a.value,
          }))
        : undefined;
      // Legacy shape used `imageUrl` (some older callers) OR `frontImageUrl`
      // depending on vintage. Prefer explicit `imageUrl`, fall back to
      // `frontImageUrl` for cross-shape consistency.
      const imageUrl = raw.imageUrl ?? raw.frontImageUrl;
      return {
        tokenId: raw.tokenId,
        name: raw.name,
        setName: raw.setName,
        cardNumber: raw.cardNumber,
        pokemonName: raw.pokemonName,
        ownerAddress: raw.ownerAddress,
        askPriceInUSDT: raw.askPriceInUSDT,
        askExpiresAt: raw.askExpiresAt,
        fmvPriceInUSD: raw.fmvPriceInUSD,
        frontImageUrl: raw.frontImageUrl,
        backImageUrl: raw.backImageUrl,
        frontWithoutStandImageUrl: raw.frontWithoutStandImageUrl,
        imageUrl,
        gradingCompany: raw.gradingCompany,
        grade: raw.grade,
        serial: raw.serial,
        year: raw.year,
        vaultLocation: raw.vaultLocation,
        attributes: attrs,
        _shapeVariant: 'legacy',
      };
    }),
  ]);

export const renaissListingSchema = z
  .object({
    id: z.string(),
    tokenId: z.string(),
    priceInUSD: priceFieldSchema,
    seller: z.string().optional(),
    listedAt: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

/**
 * The `/marketplace/listings` endpoint sometimes returns a bare array and
 * sometimes a `{ items: [...] }` envelope. Accept either; the client
 * normalizes to an array.
 */
export const renaissListingsResponseSchema = z.union([
  z.array(renaissListingSchema),
  z
    .object({
      items: z.array(renaissListingSchema).optional(),
    })
    .passthrough(),
]);

/**
 * User profile schema. Modeled on the live openapi contract at
 * https://api.renaiss.xyz/openapi.json for GET /v0/users/{id}.
 *
 * REAL live field names:
 *   - `avatarUrl` (NOT `avatar`)
 *   - `favoritedSBTs` (NOT `sbtBadges`)
 *   - `favoritedCollectibles[].collectible` may be `null`
 *
 * Passthrough is enabled so any future non-breaking additions do not blow up
 * the profile route.
 */
export const renaissUserCollectibleItemSchema = z
  .object({
    setName: z.string(),
    name: z.string(),
    year: z.number(),
    cardNumber: z.string(),
    gradingCompany: z.union([z.string(), z.null()]).optional(),
    grade: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

export const renaissUserCollectibleSchema = z
  .object({
    item: renaissUserCollectibleItemSchema,
    gradingCompany: z.union([z.string(), z.null()]).optional(),
    grade: z.union([z.string(), z.null()]).optional(),
    // Live shape: string cents (e.g. "51045" == $510.45), nullable, or absent.
    fmvPriceInUsd: z.union([z.string(), z.null()]).optional(),
    frontWithoutStandImageUrl: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

export const renaissUserFavoritedCollectibleSchema = z
  .object({
    tokenId: z.string(),
    // Collectible may be null when the token has been delisted / not indexed.
    collectible: z.union([renaissUserCollectibleSchema, z.null()]),
  })
  .passthrough();

export const renaissUserSbtSchema = z
  .object({
    id: z.number(),
    title: z.string(),
    description: z.string(),
    imageUrl: z.string(),
  })
  .passthrough();

export const renaissUserSchema = z
  .object({
    id: z.string().uuid(),
    username: z.string(),
    avatarUrl: z.string(),
    favoritedCollectibles: z.array(renaissUserFavoritedCollectibleSchema),
    favoritedSBTs: z.array(renaissUserSbtSchema),
  })
  .passthrough();

/**
 * `/v0/marketplace` search response.
 *
 * Live shape verified against `https://api.renaiss.xyz/openapi.json` on
 * 2026-07-02. The `collection[]` items are Renaiss marketplace collectibles.
 *
 * Price fields (`askPriceInUSDT`, `fmvPriceInUSD`) arrive as either integer
 * strings (main API style, USD cents for FMV, wei for USDT ask) OR the
 * sentinels `"NO-ASK-PRICE"` / `"NO-FMV-PRICE"`. Consumers must funnel through
 * `parsePriceCents` for arithmetic on FMV; ask price is displayed only.
 *
 * `passthrough()` is used because the live surface is documented as evolving
 * and additive changes (e.g. a new `promoBadge` field) must not break the
 * indexer / /browse Discord command.
 */
export const renaissMarketplaceAttributeSchema = z
  .object({
    trait: z.string(),
    value: z.string(),
  })
  .passthrough();

export const renaissMarketplaceOwnerSchema = z
  .object({
    username: z.string(),
  })
  .passthrough();

export const renaissMarketplaceCustodyProviderSchema = z
  .object({
    id: z.string(),
    businessName: z.string(),
    countryCode: z.string(),
  })
  .passthrough();

export const renaissMarketplaceItemSchema = z
  .object({
    tokenId: z.string(),
    name: z.string(),
    setName: z.string(),
    cardNumber: z.string(),
    pokemonName: z.string().optional(),
    ownerAddress: z.string(),
    askPriceInUSDT: z.union([z.string(), z.null()]).optional(),
    askExpiresAt: z.string().optional(),
    fmvPriceInUSD: z.union([z.string(), z.null()]).optional(),
    attributes: z.array(renaissMarketplaceAttributeSchema).default([]),
    vaultLocation: z.string(),
    gradingCompany: z.string(),
    grade: z.string(),
    year: z.number(),
    custodyProvider: renaissMarketplaceCustodyProviderSchema.optional(),
    ownerAcquiredAt: z.string().optional(),
    owner: z.union([renaissMarketplaceOwnerSchema, z.null()]),
  })
  .passthrough();

export const renaissMarketplacePaginationSchema = z
  .object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    hasMore: z.boolean(),
  })
  .passthrough();

export const renaissMarketplaceSearchResponseSchema = z
  .object({
    collection: z.array(renaissMarketplaceItemSchema),
    pagination: renaissMarketplacePaginationSchema,
  })
  .passthrough();

export type RenaissMarketplaceItem = z.infer<typeof renaissMarketplaceItemSchema>;
export type RenaissMarketplacePagination = z.infer<
  typeof renaissMarketplacePaginationSchema
>;
export type RenaissMarketplaceSearchResponse = z.infer<
  typeof renaissMarketplaceSearchResponseSchema
>;

export type RenaissPack = z.infer<typeof renaissPackSchema>;
export type RenaissPull = z.infer<typeof renaissPullSchema>;
export type RenaissCard = z.infer<typeof renaissCardSchema>;
export type RenaissListing = z.infer<typeof renaissListingSchema>;
export type RenaissListingsResponse = z.infer<typeof renaissListingsResponseSchema>;
export type RenaissUser = z.infer<typeof renaissUserSchema>;
export type RenaissUserFavoritedCollectible = z.infer<
  typeof renaissUserFavoritedCollectibleSchema
>;
export type RenaissUserSbt = z.infer<typeof renaissUserSbtSchema>;

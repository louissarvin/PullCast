/**
 * Runtime zod schemas for the Renaiss Index API (api.renaissos.com/v1).
 *
 * The Index API returns INTEGER `priceUsdCents` fields (distinct from the main
 * API which returns string cents). Schemas validate that contract at runtime.
 *
 * As with the main API, schemas are permissive (`passthrough`, most fields
 * optional) so a benign upstream addition does not break the client.
 */

import { z } from 'zod';
import { INDEX_BETA_DISCLOSURE } from './types-runtime.ts';

/**
 * `_disclosure` is attached client-side (see `withDisclosure` in client.ts).
 * The schema makes it optional so we can validate the RAW upstream payload
 * before we attach the marker.
 */
const disclosureField = z.literal(INDEX_BETA_DISCLOSURE).optional();

// Renaiss OS Index confidence tiers. `prime` was added upstream in mid-2026;
// keep the enum in one place so all schemas stay in sync.
const CONFIDENCE_VALUES = ['prime', 'high', 'medium', 'low'] as const;
const confidenceSchema = z.enum(CONFIDENCE_VALUES).optional();

/**
 * Slug enums used across every Index API endpoint. Declared up-front so all
 * downstream schemas (both by-id and slug-family) can reference them without
 * hitting the TDZ. Prior to 2026-07-03 these were declared further down the
 * file and every schema that referenced them threw ReferenceError on load;
 * the D8/D9 code happened not to import them until after upstream evaluation
 * completed elsewhere in the module, which masked the bug at runtime.
 */
const gameSlugSchema = z.enum(['pokemon', 'one-piece', 'sports']);

const gradingCompanySchema = z
  .enum(['PSA', 'BGS', 'CGC', 'SGC', 'RAW'])
  .nullable();

export const indexCardSchema = z
  .object({
    name: z.string().optional(),
    setName: z.string().optional(),
    cardNumber: z.string().optional(),
    gradingCompany: z.string().optional(),
    grade: z.string().optional(),
    priceUsdCents: z.union([z.number(), z.null()]).optional(),
    confidence: confidenceSchema,
    lastSaleAt: z.union([z.string(), z.null()]).optional(),
    imageUrl: z.string().optional(),
  })
  .passthrough();

export const indexCertImagesSchema = z
  .object({
    // Live OpenAPI declares all three as `string | null` (required). Accept
    // both null and missing so a cached row written under either regime
    // hydrates cleanly.
    front: z.union([z.string(), z.null()]).optional(),
    back: z.union([z.string(), z.null()]).optional(),
    item: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

export const indexGradedSchema = z
  .object({
    cert: z.string(),
    found: z.boolean(),
    reason: z.string().nullable().optional(),
    card: indexCardSchema.optional(),
    certImages: indexCertImagesSchema.optional(),
    raw: z.unknown().optional(),
    _disclosure: disclosureField,
  })
  .passthrough();

export const indexSearchResultSchema = z
  .object({
    cardId: z.string().optional(),
    name: z.string().optional(),
    setName: z.string().optional(),
    cardNumber: z.string().optional(),
    game: z.string().optional(),
    company: z.string().optional(),
    grade: z.string().optional(),
    gradeLabel: z.string().optional(),
    priceUsdCents: z.union([z.number(), z.null()]).optional(),
    confidence: z.string().optional(),
    lastSaleAt: z.string().optional(),
    href: z.string().optional(),
    imageUrl: z.string().optional(),
    _disclosure: disclosureField,
  })
  .passthrough();

/**
 * Trade card block from GET /v1/trades/recent. Live shape verified 2026-07-02.
 * The full `card` sub-object of a recent trade carries just enough fields to
 * render an alert embed (name + set + grade + image) without a second lookup.
 */
export const indexTradeCardSchema = z
  .object({
    game: z.string().optional(),
    name: z.string().optional(),
    setCode: z.string().nullable().optional(),
    setName: z.string().nullable().optional(),
    cardNumber: z.string().nullable().optional(),
    grade: z.string().nullable().optional(),
    gradeLabel: z.string().nullable().optional(),
    variation: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    href: z.string().optional(),
    imageUrl: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Recent-trade record from GET /v1/trades/recent. Shape verified against
 * https://api.renaissos.com/v1/trades/recent on 2026-07-02.
 *
 * All identifying/legacy fields (tradeId, cardId, occurredAt) are optional so
 * historical D2-era fixtures still parse; the new live-shape fields carry the
 * data we actually use for the Big Trade Alert worker.
 */
export const indexTradeSchema = z
  .object({
    // Legacy D2 fields; optional for backward compatibility with older code.
    tradeId: z.string().optional(),
    cardId: z.string().optional(),
    occurredAt: z.string().optional(),
    // Live-verified fields (2026-07-02):
    source: z.string().optional(),
    bucket: z.string().optional(),
    displayName: z.string().optional(),
    observedAt: z.string().optional(),
    kind: z.string().optional(),
    priceUsdCents: z.union([z.number(), z.null()]).optional(),
    priceMinor: z.union([z.number(), z.null()]).optional(),
    currency: z.string().optional(),
    detail: z.string().nullable().optional(),
    sourceUrl: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    grade: z.string().nullable().optional(),
    gradeLabel: z.string().nullable().optional(),
    card: indexTradeCardSchema.optional(),
    _disclosure: disclosureField,
  })
  .passthrough();

export const indexFmvPointSchema = z
  .object({
    cardId: z.string(),
    asOf: z.string(),
    fmvUsdCents: z.union([z.number(), z.null()]),
    _disclosure: disclosureField,
  })
  .passthrough();

/**
 * Endpoints that return lists may come back as a bare array or wrapped in
 * `{ items | trades | results: [...] }`. The client normalizes via
 * `unwrapIndexList` after zod parse.
 */
const listResponse = <S extends z.ZodTypeAny>(item: S) =>
  z.union([
    z.array(item),
    z
      .object({
        items: z.array(item).optional(),
        trades: z.array(item).optional(),
        results: z.array(item).optional(),
      })
      .passthrough(),
  ]);

/**
 * Normalize Index API list payloads. Live shapes verified 2026-07-09:
 *   GET /v1/trades/recent → { trades: [...] }
 *   GET /v1/search        → { query, results: [...] }
 */
export const unwrapIndexList = <T>(
  data: unknown,
  keys: string[] = ['items', 'trades', 'results']
): T[] => {
  if (Array.isArray(data)) return data as T[];
  if (data !== null && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of keys) {
      const value = obj[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
};

export const indexSearchResponseSchema = listResponse(indexSearchResultSchema);
export const indexTradesResponseSchema = listResponse(indexTradeSchema);
export const indexFmvSeriesResponseSchema = listResponse(indexFmvPointSchema);

// ---------------------------------------------------------------------------
// D8 primitives: /v1/indices, /v1/indices/{game}, /v1/cards/featured, and the
// shared CardSummary + Deltas + SeriesPoint used across the slug family.
//
// Declared HERE (above the D9 detail block) so every downstream schema that
// references these names sees an initialized const. Previously the D8 block
// lived at the bottom of the file and the D9 detail schemas referenced these
// names before they existed — a TDZ crash that was masked by module-loading
// order in the running app but blew up on any direct import.
//
// Response contract per api.renaissos.com/v1/openapi.json inspected on
// 2026-07-02. Passthrough on top-level objects so a benign upstream field
// addition does not break us; nested field types match the OpenAPI enum values
// exactly. Live samples confirm: game slugs `pokemon|one-piece|sports`, deltas
// nullable numbers, sparkline is an array of SeriesPoint objects (NOT a bare
// number[] as file 17 §4 speculated - live shape matches OpenAPI).
// ---------------------------------------------------------------------------

export const indexDeltasSchema = z
  .object({
    d7: z.number().nullable(),
    d30: z.number().nullable(),
    d365: z.number().nullable(),
  })
  .passthrough();

/**
 * SeriesPoint from the Index API. Sparkline arrays are populated with this
 * shape; only `t` and `usdCents` are guaranteed by the OpenAPI required list.
 */
export const indexSeriesPointSchema = z
  .object({
    t: z.string(),
    usdCents: z.number().int().nonnegative(),
    source: z.string().nullable().optional(),
    bucket: z.string().nullable().optional(),
    n: z.number().int().nonnegative().optional(),
    kind: z.string().nullable().optional(),
    company: gradingCompanySchema.optional(),
    grade: z.string().nullable().optional(),
    gradeLabel: z.string().optional(),
  })
  .passthrough();

export const indexMoverSchema = z
  .object({
    name: z.string(),
    setCode: z.string().nullable(),
    cardNumber: z.string().nullable(),
    grade: z.string(),
    href: z.string(),
    deltaPct: z.number().nullable(),
  })
  .passthrough();

export const indexTileSchema = z
  .object({
    game: gameSlugSchema,
    label: z.string(),
    value: z.number(),
    base: z.number(),
    deltas: indexDeltasSchema,
    constituentCount: z.number().int().nonnegative(),
    rebalance: z.string(),
    sparkline: z.array(indexSeriesPointSchema),
    topMovers: z.array(indexMoverSchema),
    updatedAt: z.string().nullable(),
  })
  .passthrough();

export const indicesResponseSchema = z
  .object({
    indices: z.array(indexTileSchema),
  })
  .passthrough();

/**
 * Constituent element inside IndexDetail. The OpenAPI declares the shape but
 * we accept it as a passthrough object; downstream code only reads a handful
 * of fields (name, deltaPct, priceUsdCents).
 */
export const indexConstituentSchema = z
  .object({
    name: z.string().optional(),
    setCode: z.string().nullable().optional(),
    cardNumber: z.string().nullable().optional(),
    grade: z.string().optional(),
    href: z.string().optional(),
    priceUsdCents: z.number().int().nullable().optional(),
    deltaPct: z.number().nullable().optional(),
    weight: z.number().nullable().optional(),
  })
  .passthrough();

export const indexDetailSchema = indexTileSchema
  .extend({
    windowDays: z.number().int().positive(),
    baseDate: z.string().nullable(),
    constituents: z.array(indexConstituentSchema),
  })
  .passthrough();

/**
 * CardSummary from GET /v1/cards/featured. Live shape verified 2026-07-02.
 * Note that `type` is the uppercase discriminator (POKEMON/ONE_PIECE/SPORTS)
 * distinct from `game` (pokemon/one-piece/sports).
 */
export const cardSummarySchema = z
  .object({
    game: gameSlugSchema,
    type: z.enum(['POKEMON', 'ONE_PIECE', 'SPORTS']),
    name: z.string(),
    setName: z.string().nullable(),
    setCode: z.string().nullable(),
    cardNumber: z.string().nullable(),
    variation: z.string().nullable(),
    language: z.string().nullable(),
    imageUrl: z.string().nullable(),
    imageUrlThumb: z.string().nullable().optional(),
    company: gradingCompanySchema,
    grade: z.string().nullable(),
    gradeLabel: z.string(),
    priceUsdCents: z.number().int().nonnegative().nullable(),
    deltaPct: z.number().nullable(),
    confidence: z.enum(CONFIDENCE_VALUES).nullable(),
    lastSaleAt: z.string().nullable(),
    href: z.string(),
    spark: z.array(z.number().int().nonnegative()).optional(),
  })
  .passthrough();

export const featuredResponseSchema = z
  .object({
    cards: z.array(cardSummarySchema),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// D9: by-renaiss-id/{rid} endpoints.
//
// The Index API exposes 5 endpoints keyed by the upstream
// `items.renaiss_item_id` (a UUID, e.g. `12670e6b-f07a-4a56-bc37-4f5e42edc6a8`).
// Contract verified live 2026-07-03 against
// https://api.renaissos.com/v1/openapi.json.
//
// These schemas are shared between the by-renaiss-id and by-id endpoint
// families since the OpenAPI spec resolves both to the same underlying
// CardDetail / CardOverview / TradesResponse / SeriesResponse / FmvSeriesResponse
// shapes (with a representative grade — PSA 10 when available).
//
// Passthrough is applied to every level so a benign upstream additive change
// does not blow up the client.
// ---------------------------------------------------------------------------

const sourceBreakdownEntrySchema = z
  .object({
    source: z.string(),
    bucket: z.string(),
    displayName: z.string(),
    count: z.number().int().nonnegative(),
    medianUsdCents: z.number().int().nullable().optional(),
    overviewUrl: z.string().nullable().optional(),
  })
  .passthrough();

const fmvMethodValueSchema = z
  .object({
    method: z.string(),
    scorerVersion: z.string().optional(),
    label: z.string().optional(),
    priceUsdCents: z.number().int().nullable().optional(),
    confidence: z.enum(CONFIDENCE_VALUES).nullable().optional(),
    sourceCount: z.number().int().nonnegative().optional(),
    observationCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const gradeRowSchema = z
  .object({
    company: z.string().nullable(),
    grade: z.string().nullable(),
    gradeLabel: z.string(),
    priceUsdCents: z.number().int().nullable(),
    deltaPct: z.number().nullable(),
    confidence: z.enum(CONFIDENCE_VALUES).nullable(),
    lastSaleAt: z.string().nullable(),
    href: z.string(),
    current: z.boolean(),
  })
  .passthrough();

/**
 * GET /v1/cards/by-renaiss-id/{rid}
 * GET /v1/cards/by-id/{id}
 * GET /v1/cards/{game}/{set}/{card}
 *
 * All three routes return the same CardDetail shape (per OpenAPI). We keep
 * every field permissive so downstream Discord/HTTP consumers can rely on
 * whatever subset they need without a parse failure blocking access.
 */
export const indexCardDetailSchema = z
  .object({
    id: z.string(),
    game: gameSlugSchema,
    type: z.enum(['POKEMON', 'ONE_PIECE', 'SPORTS']),
    name: z.string(),
    setName: z.string().nullable(),
    setCode: z.string().nullable(),
    cardNumber: z.string().nullable(),
    variation: z.string().nullable(),
    language: z.string().nullable(),
    imageUrl: z.string().nullable(),
    imageUrlLg: z.string().nullable(),
    company: gradingCompanySchema,
    grade: z.string().nullable(),
    gradeLabel: z.string(),
    priceUsdCents: z.number().int().nullable(),
    deltas: indexDeltasSchema,
    confidence: z.enum(CONFIDENCE_VALUES).nullable(),
    sourceCount: z.number().int().nullable().optional(),
    observationCount: z.number().int().nullable().optional(),
    observationWindowDays: z.number().int().nullable().optional(),
    totalObservationCount: z.number().int().nullable().optional(),
    updatedAt: z.string().nullable(),
    lastSaleAt: z.string().nullable(),
    refreshing: z.boolean().optional(),
    sourceBreakdown: z.array(sourceBreakdownEntrySchema).optional(),
    sourceBreakdownAllTime: z.array(sourceBreakdownEntrySchema).optional(),
    trackedSources: z.array(sourceBreakdownEntrySchema).optional(),
    methods: z.array(fmvMethodValueSchema).optional(),
    otherGrades: z.array(gradeRowSchema).optional(),
    otherLanguages: z.array(z.unknown()).optional(),
    otherVariants: z.array(z.unknown()).optional(),
    similar: z.array(cardSummarySchema).optional(),
    href: z.string(),
    pageUrl: z.string().optional(),
    _disclosure: disclosureField,
  })
  .passthrough();

const cardOverviewGradeSchema = z
  .object({
    company: z.string().nullable(),
    grade: z.string().nullable(),
    gradeLabel: z.string(),
    priceUsdCents: z.number().int().nullable(),
    deltaPct: z.number().nullable(),
    confidence: z.enum(CONFIDENCE_VALUES).nullable(),
    sourceCount: z.number().int().nullable().optional(),
    observationCount: z.number().int().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    lastSaleAt: z.string().nullable().optional(),
    spark: z.array(z.number()).optional(),
    href: z.string(),
  })
  .passthrough();

/**
 * GET /v1/cards/by-renaiss-id/{rid}/overview
 * GET /v1/cards/by-id/{id}/overview
 *
 * Grade-agnostic overview: one card blob + per-grade rows.
 */
export const indexCardDetailOverviewSchema = z
  .object({
    game: gameSlugSchema,
    type: z.enum(['POKEMON', 'ONE_PIECE', 'SPORTS']),
    name: z.string(),
    setName: z.string().nullable(),
    setCode: z.string().nullable(),
    cardNumber: z.string().nullable(),
    variation: z.string().nullable(),
    language: z.string().nullable(),
    imageUrl: z.string().nullable(),
    imageUrlLg: z.string().nullable(),
    gradeCount: z.number().int().nonnegative(),
    href: z.string(),
    grades: z.array(cardOverviewGradeSchema),
    _disclosure: disclosureField,
  })
  .passthrough();

const tradeRowSchema = z
  .object({
    source: z.string(),
    bucket: z.string(),
    displayName: z.string(),
    observedAt: z.string(),
    kind: z.string(),
    priceUsdCents: z.number().int().nullable(),
    priceMinor: z.number().int().nullable().optional(),
    currency: z.string().optional(),
    detail: z.string().nullable().optional(),
    sourceUrl: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    grade: z.string().nullable().optional(),
    gradeLabel: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * GET /v1/cards/by-renaiss-id/{rid}/trades
 */
export const indexCardTradesResponseSchema = z
  .object({
    trades: z.array(tradeRowSchema),
    total: z.number().int().nonnegative(),
  })
  .passthrough();

/**
 * GET /v1/cards/by-renaiss-id/{rid}/series
 *
 * Live shape: { windowDays, points: SeriesPoint[] } where each SeriesPoint
 * carries a `t` (ISO date) and `usdCents`. Passthrough because the item can
 * carry optional grade/company/source metadata we don't strictly parse.
 */
export const indexCardSeriesResponseSchema = z
  .object({
    windowDays: z.number().int().positive(),
    points: z.array(indexSeriesPointSchema),
  })
  .passthrough();

const fmvSeriesPointSchema = z
  .object({
    t: z.string(),
    usdCents: z.number().int().nonnegative(),
    n: z.number().int().nonnegative().optional(),
    bySource: z
      .array(
        z
          .object({
            source: z.string(),
            bucket: z.string(),
            displayName: z.string(),
            usdCents: z.number().int().nonnegative(),
            n: z.number().int().nonnegative(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

const fmvMethodSeriesSchema = z
  .object({
    method: z.string(),
    scorerVersion: z.string().optional(),
    label: z.string().optional(),
    points: z.array(
      z
        .object({
          t: z.string(),
          usdCents: z.number().int().nonnegative(),
        })
        .passthrough()
    ),
  })
  .passthrough();

/**
 * GET /v1/cards/by-renaiss-id/{rid}/fmv-series
 */
export const indexCardFmvSeriesResponseSchema = z
  .object({
    windowDays: z.number().int().positive(),
    fmvWindowDays: z.number().int().positive(),
    gradeLabel: z.string().nullable(),
    points: z.array(fmvSeriesPointSchema),
    series: z.array(fmvMethodSeriesSchema),
  })
  .passthrough();

/**
 * GET /v1/cards/by-id/{id}/overview. Loose shape: server returns grade-blended
 * FMV plus aggregate stats. We accept passthrough since the exact response is
 * not fully documented in 17_renaiss_cli_indexapi_research.md Section 4.
 */
export const indexCardOverviewSchema = z
  .object({
    cardId: z.string().optional(),
    card: indexCardSchema.optional(),
  })
  .passthrough();

/**
 * GET /v1/sets/{game}/{set} — SetResponse per the live OpenAPI (verified
 * 2026-07-03 at https://api.renaissos.com/v1/openapi.json).
 *
 * `cards` is an array of CardSummary; because cardSummarySchema is now
 * declared above in the D8 primitives block we can reference it directly.
 *
 * Passthrough at the top level so a benign upstream addition (e.g. new count
 * fields) does not break the client.
 */
export const setResponseSchema = z
  .object({
    game: gameSlugSchema,
    setName: z.string().nullable(),
    setCode: z.string().nullable(),
    language: z.string().nullable().optional(),
    setSegment: z.string(),
    href: z.string(),
    cardCount: z.number().int().nonnegative(),
    cards: z.array(cardSummarySchema),
    _disclosure: disclosureField,
  })
  .passthrough();

export type IndexSetListing = z.infer<typeof setResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/report — data-issue report submission (M8).
//
// Live OpenAPI contract verified 2026-07-02 against
// https://api.renaissos.com/v1/openapi.json.
//
//   DataIssueReportInput  (request body, application/json)
//     - message: string, min 1, max 2000, required
//     - category: enum wrong_price | wrong_card | broken_link | stale | other
//                 (optional)
//     - sourceUrl: string uri max 500 | '' | omitted
//     - cardHref: string max 300 | '' | omitted
//     - contactEmail: string email max 200 | '' | omitted
//
//   SubmitResponse (201 body)
//     - ok: literal true
//     - id: string uuid
//
// The client MUST send exactly this shape; the upstream is strict
// (`additionalProperties: false`) so any extra keys will get us a 422.
// ---------------------------------------------------------------------------

export const REPORT_CATEGORY_VALUES = [
  'wrong_price',
  'wrong_card',
  'broken_link',
  'stale',
  'other',
] as const;

export const reportCategorySchema = z.enum(REPORT_CATEGORY_VALUES);

/**
 * Wire-format schema for the request body of POST /v1/report. This is the
 * EXACT shape the upstream expects; keep in lock-step with the live OpenAPI or
 * the upstream will 422 us.
 *
 * `.strict()` mirrors upstream `additionalProperties: false` so schema drift
 * fails on our side before we ship an unknown key over the wire.
 */
export const reportIssueInputSchema = z
  .object({
    message: z.string().min(1).max(2000),
    category: reportCategorySchema.optional(),
    sourceUrl: z.union([z.string().url().max(500), z.literal('')]).optional(),
    cardHref: z.union([z.string().max(300), z.literal('')]).optional(),
    contactEmail: z
      .union([z.string().email().max(200), z.literal('')])
      .optional(),
  })
  .strict();

/**
 * 201 payload we get back on a successful submission.
 */
export const reportSubmitResponseSchema = z
  .object({
    ok: z.literal(true),
    id: z.string().uuid(),
  })
  .passthrough();

export type ReportCategory = z.infer<typeof reportCategorySchema>;
export type ReportIssueInput = z.infer<typeof reportIssueInputSchema>;
export type ReportSubmitResponse = z.infer<typeof reportSubmitResponseSchema>;

export type IndexDeltas = z.infer<typeof indexDeltasSchema>;
export type IndexSeriesPoint = z.infer<typeof indexSeriesPointSchema>;
export type IndexMover = z.infer<typeof indexMoverSchema>;
export type IndexTile = z.infer<typeof indexTileSchema>;
export type IndicesResponse = z.infer<typeof indicesResponseSchema>;
export type IndexConstituent = z.infer<typeof indexConstituentSchema>;
export type IndexDetail = z.infer<typeof indexDetailSchema>;
export type CardSummary = z.infer<typeof cardSummarySchema>;
export type FeaturedResponse = z.infer<typeof featuredResponseSchema>;
export type IndexGameSlug = z.infer<typeof gameSlugSchema>;

export type IndexGraded = z.infer<typeof indexGradedSchema>;
export type IndexSearchResult = z.infer<typeof indexSearchResultSchema>;
export type IndexTradeCard = z.infer<typeof indexTradeCardSchema>;
export type IndexTrade = z.infer<typeof indexTradeSchema>;
export type IndexFmvPoint = z.infer<typeof indexFmvPointSchema>;
export type IndexSearchResponse = z.infer<typeof indexSearchResponseSchema>;
export type IndexTradesResponse = z.infer<typeof indexTradesResponseSchema>;
export type IndexFmvSeriesResponse = z.infer<typeof indexFmvSeriesResponseSchema>;
export type IndexCardOverview = z.infer<typeof indexCardOverviewSchema>;

// D9: by-renaiss-id / by-id detail family.
export type IndexCardDetail = z.infer<typeof indexCardDetailSchema>;
export type IndexCardDetailOverview = z.infer<typeof indexCardDetailOverviewSchema>;
export type IndexCardTradesResponse = z.infer<typeof indexCardTradesResponseSchema>;
export type IndexCardSeriesResponse = z.infer<typeof indexCardSeriesResponseSchema>;
export type IndexCardFmvSeriesResponse = z.infer<typeof indexCardFmvSeriesResponseSchema>;

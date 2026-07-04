/**
 * Types for the Renaiss Index API (api.renaissos.com/v1).
 *
 * As of D2, all types are inferred from the zod schemas in `schemas.ts` so the
 * runtime validators and TS types cannot drift.
 *
 * Per file 17, this API returns prices as INTEGER `priceUsdCents` (not the
 * string-cents quirk of the main API). We still funnel everything through
 * `parsePriceCents` from `lib/renaiss` so downstream code does not have to
 * remember which surface produced the value.
 */

import { parsePriceCents } from '../renaiss/types.ts';

export { INDEX_BETA_DISCLOSURE } from './types-runtime.ts';
export type { IndexBetaDisclosure } from './types-runtime.ts';

export type {
  IndexGraded,
  IndexSearchResult,
  IndexTrade,
  IndexFmvPoint,
  IndexSearchResponse,
  IndexTradesResponse,
  IndexFmvSeriesResponse,
} from './schemas.ts';

/**
 * Marker interface kept for backwards compatibility with D1 consumers.
 * Every returned object from the Index API client carries `_disclosure` so any
 * consumer that forwards the data to Discord or HTTP cannot accidentally drop
 * the mandatory beta footer.
 */
export interface IndexBeta {
  _disclosure: 'Beta data from Renaiss Index API (experimental). Not financial advice.';
}

/**
 * Re-export so callers do not have to import from two places.
 */
export { parsePriceCents };

/**
 * Runtime constants split from `types.ts` so `schemas.ts` can import the
 * disclosure literal without pulling in the type-only re-export graph.
 */

export const INDEX_BETA_DISCLOSURE =
  'Beta data from Renaiss Index API (experimental). Not financial advice.' as const;

export type IndexBetaDisclosure = typeof INDEX_BETA_DISCLOSURE;

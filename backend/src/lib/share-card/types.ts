/**
 * Input/output contract for the share-card renderer.
 *
 * The renderer is intentionally Prisma-free so it can be invoked from anywhere
 * (indexer pipeline, OG route, CLI test script). Callers normalize a Pull row
 * into `ShareCardInput` before invoking `renderShareCard`.
 *
 * Pricing is integer USD cents end-to-end. The renderer formats for display
 * (`$1,234.56`) but performs no math beyond formatting.
 */

export type ShareCardStyleVariant = 'psa' | 'bgs' | 'cgc' | 'generic';

export interface ShareCardInput {
  cardName: string;
  setName?: string;
  cardNumber?: string;
  /** Front-facing card image. The renderer fetches and inlines as a data URL. */
  imageUrl: string;
  /** Display label for the pack (Eden Pack, OMEGA, RenaCrypt). */
  packLabel: string;
  packPriceUsdCents: number;
  fmvUsdCents: number | null;
  netGainUsdCents: number | null;
  gradingCompany?: 'PSA' | 'BGS' | 'CGC' | 'SGC' | null;
  /** Grade label as it appears upstream: "10", "9.5", "Gem Mint", etc. */
  grade?: string | null;
  serial?: string | null;
  /** 0x-prefixed buyer address. Will be displayed in short form. */
  buyerAddress: string;
  pulledAt: Date;
  /** Gacha tier label from the Renaiss main API; drives accent color in generic variant. */
  tier?: string | null;
  /** Optional override; when omitted the renderer detects from gradingCompany. */
  styleVariant?: ShareCardStyleVariant;
}

export interface RenderedShareCard {
  png: Buffer;
  widthPx: number;
  heightPx: number;
  styleVariant: ShareCardStyleVariant;
  byteSize: number;
}

/**
 * Satori accepts plain object trees that mirror the React element shape.
 * We model that minimally here so we never need to depend on `react` at
 * compile-time and keep the renderer tree-shake-friendly.
 */
export interface SatoriNode {
  type: string;
  props: {
    style?: Record<string, unknown>;
    children?: SatoriNode | SatoriNode[] | string | number | null;
    [key: string]: unknown;
  };
}

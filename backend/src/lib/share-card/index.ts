/**
 * Public barrel for the share-card module.
 *
 * Downstream callers (indexer pipeline, OG route, Discord poster) MUST import
 * from this file and not reach into internal templates. Keeps the surface
 * stable while letting the templates iterate.
 */

export { renderShareCard, detectStyle, fetchImageAsDataUrl } from './render.ts';
export type {
  ShareCardInput,
  RenderedShareCard,
  ShareCardStyleVariant,
  SatoriNode,
} from './types.ts';

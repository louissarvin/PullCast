/**
 * Share-card render pipeline.
 *
 * Pipeline:
 *   1. Pick a style variant (explicit, else detected from gradingCompany).
 *   2. Fetch the card image and inline it as a data URL (Satori cannot fetch).
 *   3. Build the Satori element tree from the chosen template.
 *   4. Run Satori -> SVG string.
 *   5. Run @resvg/resvg-js -> PNG buffer.
 *
 * Performance target: < 800ms on a warm cache (fonts loaded). Cold renders
 * include the font read + image fetch and can exceed that budget; the indexer
 * pre-warms the font cache at startup to keep the hot path fast.
 */

import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

import { loadFonts } from './fonts.ts';
import { render as renderBgs } from './templates/bgs.ts';
import { render as renderCgc } from './templates/cgc.ts';
import { render as renderGeneric } from './templates/generic.ts';
import { render as renderPsa } from './templates/psa.ts';
import { THEME } from './theme.ts';
import type {
  RenderedShareCard,
  SatoriNode,
  ShareCardInput,
  ShareCardStyleVariant,
} from './types.ts';

const LOG_PREFIX = '[share-card]';

const IMAGE_FETCH_TIMEOUT_MS = 5000;

/**
 * H-4: SSRF defense. We only allow `https:` fetches to a small set of Renaiss
 * origins (plus `data:` URLs which are inlined locally). Without this guard,
 * a malicious indexer response could point `imageUrl` at internal services
 * (e.g. `http://169.254.169.254/...` AWS IMDS) or other private hosts.
 */
const ALLOWED_IMAGE_HOSTS = new Set([
  'cdn.renaiss.xyz',
  'images.renaiss.xyz',
  'api.renaiss.xyz',
  'api.renaissos.com',
  'bhshyxmgzwogzgcf.public.blob.vercel-storage.com',
  'placehold.co', // for test-render.ts samples
]);

const isSafeImageUrl = (raw: string): boolean => {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  if (raw.startsWith('data:')) return true; // base64-inlined images OK
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_IMAGE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
};

/**
 * 1x1 transparent PNG used when the remote card image cannot be fetched. Keeps
 * the render alive instead of crashing so the indexer pipeline degrades to a
 * "missing image" share card we can still post.
 */
const TRANSPARENT_PIXEL_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export const detectStyle = (
  grader: ShareCardInput['gradingCompany']
): ShareCardStyleVariant => {
  switch (grader) {
    case 'PSA':
      return 'psa';
    case 'BGS':
      return 'bgs';
    case 'CGC':
      return 'cgc';
    case 'SGC':
    default:
      return 'generic';
  }
};

const pickTemplate = (
  variant: ShareCardStyleVariant
): ((input: ShareCardInput, imageSrc: string) => SatoriNode) => {
  switch (variant) {
    case 'psa':
      return renderPsa;
    case 'bgs':
      return renderBgs;
    case 'cgc':
      return renderCgc;
    case 'generic':
    default:
      return renderGeneric;
  }
};

const guessMimeFromContentType = (raw: string | null): string => {
  if (!raw) return 'image/jpeg';
  const lower = raw.toLowerCase();
  if (lower.startsWith('image/png')) return 'image/png';
  if (lower.startsWith('image/jpeg') || lower.startsWith('image/jpg')) return 'image/jpeg';
  if (lower.startsWith('image/webp')) return 'image/webp';
  if (lower.startsWith('image/gif')) return 'image/gif';
  return 'image/jpeg';
};

/**
 * Fetch a remote image and return it as a data URL Satori can inline.
 * Bounded by `IMAGE_FETCH_TIMEOUT_MS`; falls back to a 1x1 transparent PNG on
 * any failure so we never crash the render pipeline.
 */
export const fetchImageAsDataUrl = async (url: string): Promise<string> => {
  if (!url || typeof url !== 'string') {
    console.warn(`${LOG_PREFIX} missing imageUrl, using placeholder`);
    return TRANSPARENT_PIXEL_DATA_URL;
  }
  // H-4: enforce SSRF allowlist before any network call.
  if (!isSafeImageUrl(url)) {
    console.warn(`${LOG_PREFIX} blocked unsafe imageUrl=${url.slice(0, 80)}`);
    return TRANSPARENT_PIXEL_DATA_URL;
  }
  // Already a data URL; pass through.
  if (url.startsWith('data:')) return url;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    // `redirect: 'error'` defeats a 302 -> internal-IP bounce that would
    // otherwise bypass our host allowlist.
    const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!res.ok) {
      console.warn(`${LOG_PREFIX} image fetch ${url} returned ${res.status}, using placeholder`);
      return TRANSPARENT_PIXEL_DATA_URL;
    }
    const ab = await res.arrayBuffer();
    const mime = guessMimeFromContentType(res.headers.get('content-type'));
    const b64 = Buffer.from(ab).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG_PREFIX} image fetch ${url} failed: ${reason}, using placeholder`);
    return TRANSPARENT_PIXEL_DATA_URL;
  } finally {
    clearTimeout(timer);
  }
};

export const renderShareCard = async (input: ShareCardInput): Promise<RenderedShareCard> => {
  const t0 = performance.now();
  const styleVariant: ShareCardStyleVariant =
    input.styleVariant ?? detectStyle(input.gradingCompany ?? null);

  const [fonts, imageSrc] = await Promise.all([
    loadFonts(),
    fetchImageAsDataUrl(input.imageUrl),
  ]);

  const template = pickTemplate(styleVariant);
  const element = template(input, imageSrc) as unknown as Parameters<typeof satori>[0];

  const svg = await satori(element, {
    width: THEME.canvas.width,
    height: THEME.canvas.height,
    fonts: fonts.map((f) => ({
      name: f.name,
      data: f.data,
      weight: f.weight,
      style: f.style,
    })),
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: THEME.canvas.width },
    font: { loadSystemFonts: false },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();
  const png = Buffer.from(pngBuffer);

  const elapsed = Math.round(performance.now() - t0);
  console.log(`${LOG_PREFIX} rendered ${styleVariant} in ${elapsed}ms (${png.byteLength} bytes)`);

  return {
    png,
    widthPx: THEME.canvas.width,
    heightPx: THEME.canvas.height,
    styleVariant,
    byteSize: png.byteLength,
  };
};

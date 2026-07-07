/**
 * Font loader for Satori. Reads bundled Inter .ttf files from `assets/` at
 * first invocation and caches the resulting `SatoriFont[]` for the lifetime of
 * the process.
 *
 * Satori requires explicit font data; system-font fallback is not an option.
 * The three bundled weights (400, 600, 800) cover every typographic style our
 * templates use. Adding a new weight means dropping a new .ttf in
 * `assets/inter-<weight>.ttf` and appending to `FONT_WEIGHTS`.
 *
 * Fonts are sourced from fontsource (latin subset) and committed to the repo
 * so renders work offline. See d3-progress.md for the exact provenance.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOG_PREFIX = '[share-card]';

export interface SatoriFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 500 | 600 | 700 | 800 | 900;
  style: 'normal' | 'italic';
}

const FONT_WEIGHTS: Array<{ weight: SatoriFont['weight']; filename: string }> = [
  { weight: 400, filename: 'inter-400.ttf' },
  { weight: 600, filename: 'inter-600.ttf' },
  { weight: 800, filename: 'inter-800.ttf' },
];

let cachedFonts: SatoriFont[] | null = null;
let inFlight: Promise<SatoriFont[]> | null = null;

const assetsDir = (): string => {
  // import.meta.url is reliable under Bun and Node ESM. resolves to the
  // module's own directory so the cwd does not matter.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'assets');
};

const loadOne = async (filename: string, weight: SatoriFont['weight']): Promise<SatoriFont> => {
  const path = resolve(assetsDir(), filename);
  try {
    const buf = await readFile(path);
    // Slice into a fresh ArrayBuffer so Satori (which expects an
    // ArrayBuffer, not a Node Buffer) does not see SharedArrayBuffer-like
    // typing from the underlying pool.
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return {
      name: 'Inter',
      data: ab,
      weight,
      style: 'normal',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${LOG_PREFIX} failed to load font file ${path}. ` +
        `Ensure src/lib/share-card/assets/${filename} exists. Original error: ${message}`
    );
  }
};

/**
 * Returns the bundled Inter font set ready for Satori. Cached after first
 * successful call; concurrent callers share the same in-flight promise so we
 * never read the files twice.
 */
export const loadFonts = async (): Promise<SatoriFont[]> => {
  if (cachedFonts) {
    return cachedFonts;
  }
  if (inFlight) {
    return inFlight;
  }
  inFlight = (async () => {
    const fonts = await Promise.all(FONT_WEIGHTS.map((f) => loadOne(f.filename, f.weight)));
    cachedFonts = fonts;
    inFlight = null;
    console.log(`${LOG_PREFIX} loaded ${fonts.length} Inter font weights`);
    return fonts;
  })();
  return inFlight;
};

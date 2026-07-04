/**
 * Parse the `href` field the Renaiss OS Index API returns on CardSummary /
 * CardDetail / IndexMover / IndexConstituent payloads into its three slug
 * segments: `{game, setCode, cardSlug}`.
 *
 * Live-verified shape (2026-07-03 at api.renaissos.com/v1):
 *   /card/{game}/{setSegment}/{cardSlug}
 *
 * where:
 *   - `game`       : one of {pokemon, one-piece, sports}
 *   - `setSegment` : the "set slug" — same value that `/v1/sets/{game}/{set}`
 *                    accepts and that /v1/cards/featured returns as `setCode`
 *                    is NOT this; `setSegment` is a URL-safe slug of the set
 *                    display name (e.g. `pokemon-ex-unseen-forces`).
 *   - `cardSlug`   : `{number}-{name}-{company}-{grade}` optionally suffixed
 *                    with a `-{shortHash}` disambiguator that upstream tolerates.
 *
 * The parser is defensive: any input that is not a string, is missing the
 * `/card/` prefix, or has fewer than three segments returns null. Callers
 * MUST handle the null case rather than trusting the parse.
 *
 * We do NOT strip the shortHash suffix here because the upstream server
 * accepts both forms (verified) and the raw cardSlug is what /featured and
 * /search return. If a caller needs the grade-less slug (for the /overview
 * endpoint) they can call `stripGradeSuffix` below.
 */

export interface HrefSlugTriple {
  game: string;
  setCode: string;
  cardSlug: string;
}

const CARD_PATH_RE = /^\/?card\/([^/]+)\/([^/]+)\/([^/?#]+)/;

/**
 * Parse a card href into its three slug segments. Returns null on any input
 * that does not match the expected shape.
 */
export const parseCardHref = (href: unknown): HrefSlugTriple | null => {
  if (typeof href !== 'string' || href.length === 0) return null;
  // Accept absolute URLs (strip the origin) and relative paths.
  let path = href;
  if (path.startsWith('http://') || path.startsWith('https://')) {
    try {
      const u = new URL(path);
      path = u.pathname;
    } catch {
      return null;
    }
  }
  const m = CARD_PATH_RE.exec(path);
  if (m === null) return null;
  const [, game, setCode, cardSlug] = m;
  if (
    typeof game !== 'string' ||
    typeof setCode !== 'string' ||
    typeof cardSlug !== 'string'
  ) {
    return null;
  }
  return { game, setCode, cardSlug };
};

/**
 * Grade-less slug for `/v1/cards/{game}/{set}/{card}/overview`. The upstream
 * expects `{number}-{name}` with the `-{company}-{grade}` suffix stripped.
 *
 * We can't unambiguously reverse-engineer the split (grade tokens like
 * `psa-10` or `bgs-9-5` have variable length), so we take a conservative
 * pass: split by `-`, walk from the end, and drop tokens matching the known
 * grading-company / numeric-grade pattern. If nothing matches we return the
 * original slug so the caller still has a slug to try.
 */
const KNOWN_COMPANIES = new Set(['psa', 'bgs', 'cgc', 'sgc', 'ace', 'gma']);
const NUMERIC_GRADE_RE = /^\d+(\.\d+)?$/;

export const stripGradeSuffix = (cardSlug: string): string => {
  if (typeof cardSlug !== 'string' || cardSlug.length === 0) return cardSlug;
  const tokens = cardSlug.split('-');
  if (tokens.length < 3) return cardSlug;

  // Drop a trailing short-hash disambiguator (upstream card ids are 6-16 hex
  // chars). We only drop when the token is purely lowercase hex to avoid
  // clipping legit slug tail words.
  let end = tokens.length;
  const last = tokens[end - 1];
  if (typeof last === 'string' && /^[0-9a-f]{6,16}$/.test(last)) {
    end -= 1;
  }

  // Drop trailing numeric grade tokens (10, 9.5, 8-5, etc.) until we hit a
  // known company token; then drop the company token too.
  while (end > 2) {
    const tok = tokens[end - 1];
    if (typeof tok !== 'string') break;
    if (NUMERIC_GRADE_RE.test(tok)) {
      end -= 1;
      continue;
    }
    if (KNOWN_COMPANIES.has(tok.toLowerCase())) {
      end -= 1;
      break;
    }
    break;
  }

  if (end < 2) return cardSlug;
  return tokens.slice(0, end).join('-');
};

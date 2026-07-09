/**
 * Parse Renaiss OS Index card hrefs into PullCast routes.
 *
 * Live shape: /card/{game}/{setSegment}/{cardSlug}
 * e.g. /card/pokemon/pokemon-japanese-sv2a-pokemon-151/187-mew-ex-psa-10-abc123
 */

const CARD_PATH_RE = /^\/?card\/([^/]+)\/([^/]+)\/([^/?#]+)/

export interface IndexCardHrefParts {
  game: string
  set: string
  card: string
}

export function parseIndexCardHref(href: string | null | undefined): IndexCardHrefParts | null {
  if (typeof href !== 'string' || href.length === 0) return null
  let path = href
  if (path.startsWith('http://') || path.startsWith('https://')) {
    try {
      path = new URL(path).pathname
    } catch {
      return null
    }
  }
  const m = CARD_PATH_RE.exec(path)
  if (!m) return null
  const [, game, set, card] = m
  if (!game || !set || !card) return null
  return { game, set, card }
}

/** PullCast gallery path for an Index card href, or null. */
export function indexCardGalleryPath(href: string | null | undefined): string | null {
  const parts = parseIndexCardHref(href)
  if (!parts) return null
  return `/card/${encodeURIComponent(parts.game)}/${encodeURIComponent(parts.set)}/${encodeURIComponent(parts.card)}`
}

/** Canonical Renaiss OS Index public URL for an href. */
export function indexCardExternalUrl(href: string | null | undefined): string | null {
  if (typeof href !== 'string' || href.length === 0) return null
  if (href.startsWith('http://') || href.startsWith('https://')) return href
  const rel = href.startsWith('/') ? href : `/${href}`
  return `https://index.renaissos.com${rel}`
}

const KNOWN_COMPANIES = new Set(['psa', 'bgs', 'cgc', 'sgc', 'ace', 'gma'])
const NUMERIC_GRADE_RE = /^\d+(\.\d+)?$/
// Language suffixes Renaiss appends after the grade for non-English variants.
// Example failing slug: `297-eevee-snrlx-gx-psa-10-japanese` — overview wants
// either `.../-gx` or `.../-gx-japanese`, never with `-psa-10-` in between.
const KNOWN_LANGUAGES = new Set([
  'japanese',
  'english',
  'korean',
  'chinese',
  'french',
  'german',
  'italian',
  'spanish',
  'portuguese',
])

/**
 * Grade-less slug for GET /v1/cards/{game}/{set}/{card}/overview.
 * Strips trailing company/grade tokens and optional short hash disambiguator.
 */
export function stripGradeSuffix(cardSlug: string): string {
  if (typeof cardSlug !== 'string' || cardSlug.length === 0) return cardSlug
  const tokens = cardSlug.split('-')
  if (tokens.length < 3) return cardSlug

  let end = tokens.length
  const last = tokens[end - 1]
  if (typeof last === 'string' && /^[0-9a-f]{6,16}$/.test(last)) {
    end -= 1
  }

  while (end > 2) {
    const tok = tokens[end - 1]
    if (typeof tok !== 'string') break
    if (KNOWN_LANGUAGES.has(tok.toLowerCase())) {
      end -= 1
      continue
    }
    if (NUMERIC_GRADE_RE.test(tok)) {
      end -= 1
      continue
    }
    if (KNOWN_COMPANIES.has(tok.toLowerCase())) {
      end -= 1
      break
    }
    break
  }

  if (end < 2) return cardSlug
  return tokens.slice(0, end).join('-')
}

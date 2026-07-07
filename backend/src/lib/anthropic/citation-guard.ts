/**
 * Citation guard: post-process AI text to enforce the file-17 §7.6 mandates.
 *
 * Rules enforced:
 *   1. Every non-obvious paragraph MUST carry at least one valid `[source-N]`
 *      marker referencing a source the retriever actually provided.
 *   2. If grounding chunks < 2, we refuse with the exact message:
 *        "Insufficient grounding data for this card. Try /price for the raw stats."
 *   3. Every response MUST end with the exact trailing disclosure:
 *        "Experimental beta data. Not financial advice."
 *   4. `[source-N]` tokens pointing at an id NOT in the provided source set are
 *      stripped (defends against hallucinated citations).
 *
 * Defense-in-depth: the system prompt asks the model to cite. This module
 * VERIFIES it did. If the model fails, the caller refuses to publish.
 */

import { DISCLOSURE_TEXT_FULL } from '../disclosure/index.ts';
import type { Source } from './retriever.ts';

const LOG_PREFIX = '[citation-guard]';

const CITATION_RX = /\[source-(\d+)\]/g;

/**
 * Exact refusal string mandated by file-17 §7.6 for the insufficient-grounding
 * path. Surfaced verbatim. Do not translate, punctuation-hint, or paraphrase.
 */
export const INSUFFICIENT_GROUNDING_REFUSAL =
  'Insufficient grounding data for this card. Try /price for the raw stats.' as const;

/**
 * Trailing disclosure line mandated by file-17 §7.6. MUST appear as the last
 * line of every AI-produced response text. Enforced by
 * `assertTrailingDisclosure` and appended by `appendDisclosureFooter`.
 */
export const AI_TRAILING_DISCLOSURE =
  'Experimental beta data. Not financial advice.' as const;

/**
 * Minimum grounding chunks required before the AI is allowed to answer. File
 * 17 §7.6 hard rule. Enforced by `assertGroundingChunks`.
 */
export const MIN_GROUNDING_CHUNKS = 2;

interface EnforceResult {
  ok: boolean;
  reason?: string;
  citedSourceIds: number[];
}

/**
 * Extract every `[source-N]` token (regardless of validity) and return the
 * unique numeric IDs as an array. Order preserved as first-seen.
 */
const extractCitedIds = (text: string): number[] => {
  const seen = new Set<number>();
  for (const match of text.matchAll(CITATION_RX)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) {
      seen.add(n);
    }
  }
  return Array.from(seen);
};

/**
 * Verify every paragraph carries >= 1 valid `[source-N]` token. A paragraph is
 * a non-empty block separated by blank lines (`\n\n+`).
 *
 * The trailing disclosure line (if present) is excluded from the paragraph
 * check because it is a footer, not a factual claim. Everything else must
 * cite.
 */
export const enforceCitations = (
  text: string,
  sources: Source[]
): EnforceResult => {
  const validIds = new Set<number>(sources.map((s) => s.id));
  if (validIds.size === 0) {
    return {
      ok: false,
      reason: 'no-sources',
      citedSourceIds: [],
    };
  }

  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'empty-response', citedSourceIds: [] };
  }

  const allCited = extractCitedIds(text);
  if (allCited.length === 0) {
    return { ok: false, reason: 'no-citations', citedSourceIds: [] };
  }

  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    // The mandated trailing disclosure line is a footer, not a claim.
    .filter((p) => p !== AI_TRAILING_DISCLOSURE)
    .filter((p) => p !== DISCLOSURE_TEXT_FULL);

  if (paragraphs.length === 0) {
    return { ok: false, reason: 'no-paragraphs', citedSourceIds: allCited };
  }

  for (const para of paragraphs) {
    const paraIds = extractCitedIds(para);
    const hasValid = paraIds.some((id) => validIds.has(id));
    if (!hasValid) {
      console.warn(`${LOG_PREFIX} uncited paragraph: "${para.slice(0, 80)}..."`);
      return {
        ok: false,
        reason: 'uncited-claim',
        citedSourceIds: allCited.filter((id) => validIds.has(id)),
      };
    }
  }

  const validCited = allCited.filter((id) => validIds.has(id));
  return { ok: true, citedSourceIds: validCited };
};

/**
 * Remove `[source-N]` tokens where N is not in the allowed source set. The
 * model occasionally invents citation indices; strip those so the embed does
 * not surface a phantom reference. Idempotent.
 */
export const stripUnreferencedCitations = (
  text: string,
  sources: Source[]
): string => {
  if (typeof text !== 'string') return '';
  const validIds = new Set<number>(sources.map((s) => s.id));
  return text.replace(CITATION_RX, (full, idStr) => {
    const id = Number(idStr);
    if (validIds.has(id)) return full;
    console.warn(`${LOG_PREFIX} stripped hallucinated citation [source-${id}]`);
    return '';
  });
};

/**
 * Append the mandated trailing disclosure line. If the text already ends with
 * either the file-17 §7.6 short disclosure or the legacy full disclosure, do
 * NOT append a second copy (idempotent).
 *
 * Contract: the returned string ALWAYS ends with `AI_TRAILING_DISCLOSURE`.
 */
export const appendDisclosureFooter = (text: string): string => {
  const safe = typeof text === 'string' ? text.trimEnd() : '';
  if (safe.length === 0) return AI_TRAILING_DISCLOSURE;
  if (safe.endsWith(AI_TRAILING_DISCLOSURE)) return safe;
  // If the older long disclosure snuck in, rewrite the tail to satisfy the
  // file-17 §7.6 exact wording. Keep the body verbatim.
  if (safe.endsWith(DISCLOSURE_TEXT_FULL)) {
    const body = safe.slice(0, safe.length - DISCLOSURE_TEXT_FULL.length).trimEnd();
    return `${body}\n\n${AI_TRAILING_DISCLOSURE}`;
  }
  return `${safe}\n\n${AI_TRAILING_DISCLOSURE}`;
};

/**
 * Assert the response text ends with the file-17 §7.6 mandated disclosure.
 * Returns { ok: true } if so, { ok: false, reason } otherwise. Callers should
 * use this AFTER `appendDisclosureFooter` for defense-in-depth verification.
 */
export const assertTrailingDisclosure = (
  text: string
): { ok: boolean; reason?: string } => {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, reason: 'empty-text' };
  }
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(AI_TRAILING_DISCLOSURE)) {
    return { ok: false, reason: 'missing-trailing-disclosure' };
  }
  return { ok: true };
};

/**
 * Hard grounding-chunk gate. File-17 §7.6: if the retriever produced fewer
 * than `MIN_GROUNDING_CHUNKS` (default 2) sources, refuse with the exact
 * mandated message. Callers surface `refusal` verbatim to the user.
 */
export const assertGroundingChunks = (
  sources: Source[]
): { ok: true } | { ok: false; refusal: string; reason: 'insufficient-grounding' } => {
  const count = Array.isArray(sources) ? sources.length : 0;
  if (count < MIN_GROUNDING_CHUNKS) {
    console.warn(
      `${LOG_PREFIX} insufficient grounding chunks=${count} required=${MIN_GROUNDING_CHUNKS}`
    );
    return {
      ok: false,
      refusal: INSUFFICIENT_GROUNDING_REFUSAL,
      reason: 'insufficient-grounding',
    };
  }
  return { ok: true };
};

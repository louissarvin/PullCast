/**
 * Shared image URL allowlist for SSRF defense.
 *
 * Single source of truth for the set of hosts that any server-side code in
 * this repo may fetch an image from, persist an image URL for, or forward an
 * image URL into a Discord embed. This mirrors the H-4 / M-4 patch already
 * applied in `src/lib/share-card/render.ts` and `src/workers/indexer.ts` so
 * we do not maintain the allowlist in three places.
 *
 * Design:
 *  - `IMAGE_ALLOWED_HOSTS` is the base set of Renaiss-owned CDNs / API hosts
 *    that serve card imagery. `https:` only.
 *  - `isAllowedImageUrl(raw)` accepts `data:` URLs (base64-inlined images used
 *    by the Satori renderer) and any `https:` URL whose hostname is in the
 *    allowlist.
 *  - `sanitizeImageUrl(raw)` returns the canonical URL string when the input
 *    passes the allowlist, else `null`. Callers persist the returned string
 *    or fall back to a placeholder.
 *
 * NEVER accept `http:`, `file:`, `javascript:`, or any private-IP literal.
 * NEVER add a host to this set without confirming it does not proxy 30x
 * redirects to arbitrary origins.
 *
 * See:
 *  - OWASP SSRF Prevention Cheat Sheet:
 *    https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
 *  - D8-M-5 / D8-M-6 in `memory/d8-security-sweep.md`.
 */

/**
 * The union of Renaiss-owned image hosts we trust. Additive over the tighter
 * `SAFE_HOSTS` in indexer.ts and the `ALLOWED_IMAGE_HOSTS` in render.ts.
 *
 * `placehold.co` is intentionally OMITTED from the persistence / Discord paths
 * (it is only used by test-render.ts local dev harness). If we ever surface
 * a placeholder URL to end users, do it via a `data:` URL (inline) rather
 * than an outbound host.
 */
export const IMAGE_ALLOWED_HOSTS = new Set<string>([
  'cdn.renaiss.xyz',
  'images.renaiss.xyz',
  'api.renaiss.xyz',
  'api.renaissos.com',
  // Renaiss OS Index card images live on Vercel Blob storage. Confirmed via
  // GET /v1/cards/featured which returns `imageUrl` pointing at this bucket.
  // The bucket is Renaiss-owned (matches naming from their Vercel account) and
  // serves static images only — no redirect chains.
  'bhshyxmgzwogzgcf.public.blob.vercel-storage.com',
]);

/**
 * Predicate. `data:` URLs pass (inlined base64). `https:` URLs pass only when
 * the hostname is in `IMAGE_ALLOWED_HOSTS`. Everything else fails.
 */
export const isAllowedImageUrl = (raw: unknown): boolean => {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  if (raw.startsWith('data:')) return true;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    return IMAGE_ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
};

/**
 * Return the canonical URL string when `raw` passes the allowlist, else null.
 * Use this at the boundary between untrusted input (Renaiss API responses,
 * live trade feeds) and any downstream consumer that will fetch, persist, or
 * render the URL.
 *
 * Never returns `data:` URLs. Those are only meaningful to the Satori
 * renderer, not to callers that persist a URL or set an embed thumbnail.
 */
export const sanitizeImageUrl = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.startsWith('data:')) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    if (!IMAGE_ALLOWED_HOSTS.has(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
};

/**
 * Discord embed `description` fields are capped at 4096 chars server-side, but
 * per-line values (card names, grade labels) should be much shorter to avoid
 * unicode-normalization bombs and to keep digest embeds compact.
 *
 * Slices to `maxChars`, strips CR / LF / vertical tab / form feed / NEL /
 * line-separator (U+2028) / paragraph-separator (U+2029) so a malicious
 * upstream cannot inject Discord markdown line breaks that would shift the
 * embed layout. Returns `null` when the input is not a non-empty string
 * (after trimming).
 */
export const sanitizeShortText = (
  raw: unknown,
  maxChars = 128
): string | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // Use \u escape sequences for U+2028 (line separator) and U+2029 (paragraph
  // separator) — literal codepoints would be JS line terminators that
  // truncate the regex.
  const stripped = raw.replace(/[\r\n\v\f\u0085\u2028\u2029]/g, ' ');
  const trimmed = stripped.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxChars);
};

/**
 * Redact a URL for logging by stripping the pathname, query string, and hash
 * fragment. Keeps the protocol + host so operators can still identify the
 * upstream (e.g. `https://bsc-dataseed.publicnode.com/…`) without leaking
 * any API key that might be embedded in the path (e.g. Alchemy / QuickNode
 * / Ankr paid-plan URLs) or userinfo credentials.
 *
 * Returns `[invalid-url]` when the input does not parse.
 *
 * See OWASP Logging Cheat Sheet — Data to exclude:
 * https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude
 */
export const redactUrlForLog = (raw: unknown): string => {
  if (typeof raw !== 'string' || raw.length === 0) return '[invalid-url]';
  try {
    const u = new URL(raw);
    // u.host includes port when non-default. Drop userinfo (u.username /
    // u.password), path, query, and fragment.
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '[invalid-url]';
  }
};

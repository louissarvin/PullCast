/**
 * D8-M-3 (security): boundary guard for the `/api/marketplace?search=` value.
 *
 * The `search` string is forwarded to the upstream Renaiss `/v0/marketplace`
 * proxy. The upstream URL is a constant today (URL-encoded via URLSearchParams
 * in the client), so this input is NOT a live SSRF vector. But a future
 * refactor that reads `search` and fans out (e.g. an image enricher that
 * follows result URLs) would inherit an SSRF surface unless we reject
 * URL-shaped values at the boundary.
 *
 * We also reject control chars (\n \r \0) that could smuggle into a
 * downstream log record or an HTTP header consumer.
 *
 * Kept in its own tiny module (zero deps, no Prisma / no route imports) so
 * unit tests can exercise it without booting the whole marketplace route
 * module (which transitively imports the Prisma client).
 *
 * OWASP references:
 *  - SSRF Prevention Cheat Sheet Case 1:
 *    https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
 *  - Input Validation Cheat Sheet:
 *    https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
 */

export const isUrlLikeSearchValue = (raw: string): boolean => {
  const lower = raw.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('//') ||
    lower.startsWith('data:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('file:')
  ) {
    return true;
  }
  if (/[\r\n\0]/.test(raw)) return true;
  return false;
};

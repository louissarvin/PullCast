/**
 * Pure customId parser + regex allowlists for the `/report` command.
 *
 * Split out of `report.ts` so it has zero dependencies on Prisma, discord.js,
 * or the Renaiss upstream client. That lets unit tests exercise the D8-M-4
 * regex re-validation logic without loading the full command handler stack.
 *
 * See D8-M-4 in `memory/d8-security-sweep.md`:
 *   - Discord customIds are attacker-controlled after a message is posted.
 *   - The emit side validates `cert` / `token` against `CERT_RX` / `TOKEN_RX`
 *     before building the customId.
 *   - The parse side MUST re-apply the same regex or an attacker can craft a
 *     fake button whose customId encodes an arbitrary string, then submit
 *     that string as a `cert` / `tokenId` to the upstream report API.
 */

export const REPORT_MODAL_PREFIX = 'report-modal:' as const;
export const REPORT_BUTTON_PREFIX = 'report-btn:' as const;

/**
 * Cert allowlist: grader prefix (PSA / BGS / CGC / SGC) + 6-12 digits.
 * Case-insensitive on emit (we uppercase before regex); mirror that here.
 */
export const CERT_RX = /^(PSA|BGS|CGC|SGC)\d{6,12}$/i;

/**
 * Token allowlist: 1-90 decimal digits. Renaiss collectible tokenIds are
 * uint256 (up to 78 digits) but we cap at 90 to be safe.
 */
export const TOKEN_RX = /^\d{1,90}$/;

/**
 * Shared shape parser used by both the modal and button customId parsers.
 * Re-applies `CERT_RX` / `TOKEN_RX` on the parsed value so a malformed
 * customId (from a crafted interaction) is rejected before reaching any
 * upstream call.
 */
const parseCustomIdWithPrefix = (
  customId: string,
  prefix: string
): { kind: 'cert' | 'token'; value: string } | null => {
  if (!customId.startsWith(prefix)) return null;
  const rest = customId.slice(prefix.length);
  const sepIdx = rest.indexOf(':');
  if (sepIdx <= 0 || sepIdx === rest.length - 1) return null;
  const kindRaw = rest.slice(0, sepIdx);
  const value = rest.slice(sepIdx + 1);
  if (kindRaw !== 'cert' && kindRaw !== 'token') return null;
  if (value.length === 0 || value.length > 200) return null;
  // D8-M-4: re-apply the emit-side allowlist. Without this, a crafted
  // customId like `report-btn:cert:'; DROP TABLE reports; --` would forward
  // the SQL fragment as `card.cert` to the upstream report API.
  if (kindRaw === 'cert' && !CERT_RX.test(value)) return null;
  if (kindRaw === 'token' && !TOKEN_RX.test(value)) return null;
  return { kind: kindRaw, value };
};

/**
 * Parse the modal customId to recover (kind, value). Returns null on any
 * shape drift or when the encoded value fails the `CERT_RX` / `TOKEN_RX`
 * regex so the handler can bail cleanly.
 */
export const parseModalCustomId = (
  customId: string
): { kind: 'cert' | 'token'; value: string } | null =>
  parseCustomIdWithPrefix(customId, REPORT_MODAL_PREFIX);

/**
 * Parse the button customId. Same rules as `parseModalCustomId`.
 */
export const parseButtonCustomId = (
  customId: string
): { kind: 'cert' | 'token'; value: string } | null =>
  parseCustomIdWithPrefix(customId, REPORT_BUTTON_PREFIX);

/**
 * Public helper used by /valuate to build the button embedded in the
 * not-found embed. Keeping it here means the customId scheme + validation
 * are owned in one place.
 */
export const buildReportMissingCoverageCustomId = (
  kind: 'cert' | 'token',
  value: string
): string => `${REPORT_BUTTON_PREFIX}${kind}:${value}`;

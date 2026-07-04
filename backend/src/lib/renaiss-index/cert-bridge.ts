/**
 * Cert Bridge: legacy cert-only bridge, kept as a thin delegator to the
 * widened Card Bridge (`card-bridge.ts`) so existing callers do not need to
 * change their import path.
 *
 * The Card Bridge tries the rid path first (for broader coverage) and falls
 * back to the cert path. When called via this shim (rid=null), only the cert
 * path fires — matching the historical behavior.
 *
 * Fire-and-forget from the indexer; never throws to the caller.
 */

import {
  upgradeFmvFromCardBridge,
  type CardBridgeResult,
} from './card-bridge.ts';

/**
 * @deprecated Prefer `upgradeFmvFromCardBridge` which accepts both rid and
 * cert identifiers. This shim is kept for callers that only hold a cert.
 */
export interface CertBridgeResult {
  upgraded: boolean;
  reason: string;
}

export const upgradeFmvFromCert = async (
  pullId: string,
  cert: string
): Promise<CertBridgeResult> => {
  const result: CardBridgeResult = await upgradeFmvFromCardBridge(pullId, {
    rid: null,
    cert,
  });
  return { upgraded: result.upgraded, reason: result.reason };
};

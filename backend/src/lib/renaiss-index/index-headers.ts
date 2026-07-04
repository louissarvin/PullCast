/**
 * Partner-tier auth headers for Renaiss OS Index API.
 *
 * Official docs: https://index.renaissos.com/api-docs
 *   X-Api-Key    — public key id
 *   X-Api-Secret — secret (server-side only, never in web bundle)
 *
 * When both env vars are set, every Index client request includes them.
 * Public-tier (no headers) still works for development.
 */

export const buildIndexAuthHeaders = (
  extra: Record<string, string> = {}
): Record<string, string> => {
  const keyId = process.env.RENAISS_INDEX_KEY_ID ?? '';
  const secret = process.env.RENAISS_INDEX_SECRET ?? '';
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'pullcast-backend/0.1 (+https://github.com/pullcast)',
    ...extra,
  };
  if (keyId.length > 0 && secret.length > 0) {
    headers['X-Api-Key'] = keyId;
    headers['X-Api-Secret'] = secret;
  }
  return headers;
};

export const hasIndexPartnerAuth = (): boolean => {
  const keyId = process.env.RENAISS_INDEX_KEY_ID ?? '';
  const secret = process.env.RENAISS_INDEX_SECRET ?? '';
  return keyId.length > 0 && secret.length > 0;
};

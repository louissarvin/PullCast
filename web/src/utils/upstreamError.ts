import { ApiRequestError } from '@/lib/api/client'

/**
 * Map an error thrown by the API client into a user-facing empty-state
 * message. Distinguishes the Renaiss Index rate-limit case so users see
 * "quota resets in a few hours" instead of a generic failure.
 */
export function friendlyUpstreamMessage(
  error: unknown,
  fallback: string,
): { title: string; body: string; kind: 'rate-limited' | 'error' } {
  if (
    error instanceof ApiRequestError &&
    error.code === 'INDEX_API_RATE_LIMITED'
  ) {
    return {
      title: 'Live data paused',
      body: 'Renaiss OS Index is currently rate-limiting our backend. The quota resets automatically — check back in a few hours.',
      kind: 'rate-limited',
    }
  }
  return { title: 'Unavailable', body: fallback, kind: 'error' }
}

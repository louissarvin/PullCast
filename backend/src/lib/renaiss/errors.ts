/**
 * Typed error class for the Renaiss main API client.
 * Caller code is expected to catch this and decide whether to surface via
 * `handleError()` (route handlers) or log + degrade gracefully (workers).
 */
export class RenaissApiError extends Error {
  public readonly status: number | null;
  public readonly endpoint: string;
  public readonly cause: unknown;

  constructor(message: string, options: { status?: number | null; endpoint: string; cause?: unknown }) {
    super(message);
    this.name = 'RenaissApiError';
    this.status = options.status ?? null;
    this.endpoint = options.endpoint;
    this.cause = options.cause;
  }
}

/**
 * Typed error class for the Renaiss Index API client (api.renaissos.com/v1).
 *
 * Distinct from `RenaissApiError` so caller code can degrade differently:
 * Index API outages should not break the main pull-share pipeline.
 */
export class IndexApiError extends Error {
  public readonly status: number | null;
  public readonly endpoint: string;
  public readonly cause: unknown;

  constructor(message: string, options: { status?: number | null; endpoint: string; cause?: unknown }) {
    super(message);
    this.name = 'IndexApiError';
    this.status = options.status ?? null;
    this.endpoint = options.endpoint;
    this.cause = options.cause;
  }
}

/**
 * Thrown when the daily budget guard rejects a call. Distinct so callers can
 * treat it as a soft failure (e.g. fall back to cached data) rather than a
 * hard 5xx.
 */
export class IndexApiBudgetError extends IndexApiError {
  constructor(message: string) {
    super(message, { status: 429, endpoint: 'budget-guard' });
    this.name = 'IndexApiBudgetError';
  }
}

/**
 * Typed error class for BSC read failures.
 *
 * The reads in `reads.ts` swallow most errors and return null (so a missing
 * token does not throw). This class is exported for code paths that DO want
 * to bubble a typed failure (e.g. the indexer's gap-fill log scanner).
 */
export class BscReadError extends Error {
  public readonly contract: string;
  public readonly method: string;
  public readonly cause: unknown;

  constructor(
    message: string,
    options: { contract: string; method: string; cause?: unknown }
  ) {
    super(message);
    this.name = 'BscReadError';
    this.contract = options.contract;
    this.method = options.method;
    this.cause = options.cause;
  }
}

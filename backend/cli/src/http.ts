/**
 * Thin fetch helper with timeout + user-agent + basic error typing.
 *
 * Security notes:
 *  - Timeout defaults to 10s so a slow upstream cannot hang the CLI.
 *  - No body content is echoed to stdout on error; only status + endpoint.
 *  - Never logs full URLs with query strings to stderr (they may contain
 *    user-controlled cert numbers).
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const UA = 'pullcast-cli/0.0.1 (+https://pullcast.xyz)';

export class HttpError extends Error {
  status: number | null;
  endpoint: string;
  constructor(message: string, opts: { status: number | null; endpoint: string }) {
    super(message);
    this.name = 'HttpError';
    this.status = opts.status;
    this.endpoint = opts.endpoint;
  }
}

export interface GetJsonOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  // Optional injection point for tests.
  fetchImpl?: typeof fetch;
}

export async function getJson<T = unknown>(
  url: string,
  opts: GetJsonOptions = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const fetchImpl = opts.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': UA,
        ...(opts.headers ?? {}),
      },
    });
    if (!res.ok) {
      // Consume + discard the body so the socket does not linger.
      await res.text().catch(() => '');
      throw new HttpError(`Upstream returned ${res.status}`, {
        status: res.status,
        endpoint: url,
      });
    }
    const json = (await res.json()) as T;
    return json;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new HttpError(`Network error: ${reason}`, {
      status: null,
      endpoint: url,
    });
  } finally {
    clearTimeout(timer);
  }
}

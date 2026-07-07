/**
 * Singleton wrapper around the LLM provider client.
 *
 * D11 provider swap: the underlying provider is now Groq via the
 * OpenAI-compatible chat completions endpoint. The historical `anthropic/`
 * directory name and the `getAnthropic` / `isAnthropicAvailable` /
 * `AnthropicUnavailableError` exports are retained ON PURPOSE so import paths
 * across the codebase remain stable — mass renaming would be pure blast
 * radius. New code should read these as "AI client" symbols.
 *
 * Hard rules honored:
 *  - Lazy init so the server still boots when the key is stubbed (development
 *    convenience). Throwing at import-time would crash bootstrap before the
 *    indexer / Fastify routes can come up.
 *  - All env reads go through `main-config`. We never touch `process.env.X`
 *    here.
 *  - `isAnthropicAvailable()` returns true only if the key looks plausibly
 *    real (non-empty + length > 20). Used by command handlers to short-circuit
 *    cheaply before paying a request-id round-trip.
 */

import OpenAI from 'openai';

import { GROQ_API_KEY, GROQ_BASE_URL, GROQ_MODEL } from '../../config/main-config.ts';

const LOG_PREFIX = '[ai]';

let cached: OpenAI | null = null;

/**
 * Returns the lazily-constructed singleton LLM SDK client (OpenAI SDK pointed
 * at Groq's OpenAI-compatible base URL).
 *
 * Throws AnthropicUnavailableError when the API key is absent or clearly
 * stubbed. Callers SHOULD gate on `isAnthropicAvailable()` first to render a
 * friendlier "AI is offline" embed instead of a generic 500.
 *
 * The return type is kept concrete so callers can invoke
 * `client.chat.completions.create({...})` with full OpenAI typings.
 */
export const getAnthropic = (): OpenAI => {
  if (cached !== null) {
    return cached;
  }
  if (!isAnthropicAvailable()) {
    throw new AnthropicUnavailableError(
      'AI API key is missing or invalid. Set GROQ_API_KEY.'
    );
  }
  cached = new OpenAI({
    apiKey: GROQ_API_KEY,
    baseURL: GROQ_BASE_URL,
  });
  console.log(`${LOG_PREFIX} Groq client ready (model=${GROQ_MODEL})`);
  return cached;
};

/**
 * Cheap availability check. True iff the configured API key looks non-empty +
 * is at least 20 chars (real keys are >40 chars; this rules out empty strings
 * and obvious placeholders like "stub" / "TODO").
 */
export const isAnthropicAvailable = (): boolean => {
  return (
    typeof GROQ_API_KEY === 'string' && GROQ_API_KEY.length > 20
  );
};

export class AnthropicUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnthropicUnavailableError';
  }
}

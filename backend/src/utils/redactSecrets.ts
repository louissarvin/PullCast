/**
 * Secret redaction for log lines.
 *
 * Centralized scrubber for high-risk tokens that surface in third-party SDK
 * errors (discord.js's REST client, Anthropic SDK) and in raw boot failure
 * traces. Per OWASP Logging Cheat Sheet "Data to exclude":
 * https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude
 *
 * Apply at the log boundary, NOT inside business logic. Callers should use
 * `console.error('[prefix] reason', redactSecrets(err))` rather than passing
 * the raw error object to the logger.
 *
 * NEVER use this to "sanitize" a value to forward downstream; the redacted
 * string is for human consumption only.
 */

const TOKEN_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // Discord bot tokens start with MT (legacy) or similar; min 55 chars after.
  { name: 'discord-bot-token', regex: /MT[A-Za-z0-9._-]{55,}/g },
  // Anthropic API keys are sk-ant- prefixed.
  { name: 'anthropic-key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  // Generic Bearer authorization headers in stringified errors.
  { name: 'bearer-auth', regex: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi },
  // Postgres URLs (DATABASE_URL leaking through a connection error stack).
  { name: 'pg-url', regex: /postgres(ql)?:\/\/[^\s"']+/g },
];

/**
 * Serialize the input to a string and apply every redaction pattern. Returns
 * the scrubbed string. Errors are flattened to `message\nstack`; plain objects
 * go through `JSON.stringify` with a defensive fallback.
 */
export const redactSecrets = (input: unknown): string => {
  let s: string;
  if (typeof input === 'string') {
    s = input;
  } else if (input instanceof Error) {
    s = `${input.message}\n${input.stack ?? ''}`;
  } else {
    try {
      s = JSON.stringify(input);
    } catch {
      // Circular refs / non-serializable values fall back to String().
      s = String(input);
    }
  }
  for (const { name, regex } of TOKEN_PATTERNS) {
    s = s.replace(regex, `<redacted:${name}>`);
  }
  return s;
};

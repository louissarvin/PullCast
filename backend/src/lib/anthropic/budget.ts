/**
 * Per-day LLM token budget.
 *
 * D11 provider swap: numbers now come from Groq's OpenAI-shape usage object
 * (`prompt_tokens` + `completion_tokens`), not Anthropic's `input_tokens` +
 * `output_tokens`. The mapping happens in the caller (`explain.ts` /
 * `listing.ts`); this module still receives two ints and does the same math.
 *
 * Reuses the existing `RateLimitBucket` table (D2 schema) for persistence: one
 * row per UTC day with bucketKey `anthropic:tokens:YYYYMMDD`. The key prefix
 * is deliberately preserved so today's ledger row isn't orphaned by the
 * provider swap — renaming would zero out the running daily budget mid-day
 * and let an operator burn the budget twice.
 *
 * Combined prompt + completion token ledger. Output tokens cost more in
 * reality (Groq charges ~1.3x for output on Llama 3.3 70B), but a unified
 * ledger keeps the implementation honest and easy to reason about.
 *
 * NOTE: this module ONLY consults the DB. It does NOT call the LLM API.
 * The caller invokes `assertTokenBudget` BEFORE the model call (estimating
 * input tokens from prompt length) and `recordTokenSpend` AFTER, using the
 * actual `usage.prompt_tokens + usage.completion_tokens` returned by the SDK.
 */

import { Prisma } from '../../../prisma/generated/client.js';
import { nanoid } from 'nanoid';

import { ANTHROPIC_DAILY_TOKEN_BUDGET } from '../../config/main-config.ts';
import { prismaQuery } from '../prisma.ts';

const LOG_PREFIX = '[anthropic]';

export type AnthropicBudgetErrorKind = 'budget-exhausted' | 'budget-error';

export class AnthropicBudgetError extends Error {
  readonly kind: AnthropicBudgetErrorKind;
  constructor(message: string, kind: AnthropicBudgetErrorKind = 'budget-exhausted') {
    super(message);
    this.name = 'AnthropicBudgetError';
    this.kind = kind;
  }
}

/**
 * UTC YYYYMMDD string. Bucket key suffix.
 */
const todayKey = (): string => {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
};

const bucketKey = (): string => `anthropic:tokens:${todayKey()}`;

interface RemainingRow {
  remaining: number;
}

/**
 * Reads current remaining-budget for today. Creates the row lazily.
 *
 * Atomic INSERT ... ON CONFLICT DO NOTHING ensures only one process seeds the
 * row even under concurrent boot. Read follows in a separate SELECT (cheap).
 */
const ensureAndReadRemaining = async (): Promise<number> => {
  const key = bucketKey();
  const newId = nanoid();
  await prismaQuery.$executeRaw(Prisma.sql`
    INSERT INTO "RateLimitBucket" (
      "id",
      "bucketKey",
      "tokensRemaining",
      "capacity",
      "refillPerMinute",
      "lastRefillAt",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${newId},
      ${key},
      ${ANTHROPIC_DAILY_TOKEN_BUDGET},
      ${ANTHROPIC_DAILY_TOKEN_BUDGET},
      0,
      NOW(),
      NOW(),
      NOW()
    )
    ON CONFLICT ("bucketKey") DO NOTHING;
  `);

  const rows = await prismaQuery.$queryRaw<RemainingRow[]>(Prisma.sql`
    SELECT "tokensRemaining" AS remaining
    FROM "RateLimitBucket"
    WHERE "bucketKey" = ${key}
    LIMIT 1;
  `);

  if (rows.length === 0) {
    // Should be impossible after the INSERT above.
    return ANTHROPIC_DAILY_TOKEN_BUDGET;
  }
  return Number(rows[0].remaining);
};

/**
 * Refuse to proceed when projected spend would push today's bucket below zero.
 *
 * The check is OPTIMISTIC: we read the remaining budget without locking. A
 * concurrent caller could simultaneously pass the same check and both proceed
 * even if the combined spend would over-draw the budget. For a hackathon-scale
 * AI usage this is acceptable; the worst case is one extra response over the
 * budget. The hard limit lives in `recordTokenSpend` which decrements
 * atomically.
 */
export const assertTokenBudget = async (estimatedInput: number): Promise<void> => {
  if (!Number.isFinite(estimatedInput) || estimatedInput < 0) {
    estimatedInput = 0;
  }
  let remaining: number;
  try {
    remaining = await ensureAndReadRemaining();
  } catch (err) {
    // H-1: fail CLOSED on DB-read failure. Previously this fell through to
    // fail-open which let an attacker burn the entire daily budget by
    // tripping a transient DB blip. Aligned with `consumeRateLimitToken`'s
    // CLOSED posture so the two limiters behave the same way under outage.
    console.error(`${LOG_PREFIX} budget read failed (fail-closed):`, err);
    throw new AnthropicBudgetError(
      'AI budget check unavailable. Try again shortly.',
      'budget-error'
    );
  }

  if (remaining <= 0 || remaining - estimatedInput < 0) {
    console.warn(
      `${LOG_PREFIX} budget exhausted remaining=${remaining} estimatedInput=${estimatedInput}`
    );
    throw new AnthropicBudgetError(
      `Daily AI token budget exhausted (${remaining}/${ANTHROPIC_DAILY_TOKEN_BUDGET}). Try again tomorrow.`
    );
  }
};

/**
 * Atomic decrement. Combined input + output tokens are subtracted from the
 * day's remaining budget in one UPDATE.
 *
 * Tolerates negative going (the budget check is optimistic; a slight over-draw
 * is acceptable). The next `assertTokenBudget` will reject correctly because
 * `remaining <= 0` triggers the guard.
 */
export const recordTokenSpend = async (
  inputTokens: number,
  outputTokens: number
): Promise<void> => {
  if (!Number.isFinite(inputTokens) || inputTokens < 0) inputTokens = 0;
  if (!Number.isFinite(outputTokens) || outputTokens < 0) outputTokens = 0;
  const spend = Math.floor(inputTokens + outputTokens);
  if (spend === 0) return;

  const key = bucketKey();
  const newId = nanoid();
  try {
    await prismaQuery.$executeRaw(Prisma.sql`
      INSERT INTO "RateLimitBucket" (
        "id",
        "bucketKey",
        "tokensRemaining",
        "capacity",
        "refillPerMinute",
        "lastRefillAt",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${newId},
        ${key},
        ${ANTHROPIC_DAILY_TOKEN_BUDGET - spend},
        ${ANTHROPIC_DAILY_TOKEN_BUDGET},
        0,
        NOW(),
        NOW(),
        NOW()
      )
      ON CONFLICT ("bucketKey") DO UPDATE
      SET "tokensRemaining" = "RateLimitBucket"."tokensRemaining" - ${spend},
          "updatedAt" = NOW();
    `);
    console.log(
      `${LOG_PREFIX} recorded spend input=${inputTokens} output=${outputTokens} total=${spend} key=${key}`
    );
  } catch (err) {
    // Failing to RECORD spend is loud but non-fatal: we already paid the
    // upstream cost; missing the ledger update at most lets the next call
    // sneak under the budget. Log and move on.
    console.error(`${LOG_PREFIX} recordTokenSpend failed key=${key}:`, err);
  }
};

/**
 * Diagnostic helper for /health or admin dashboards. Never used in hot paths.
 */
export const getRemainingBudget = async (): Promise<number> => {
  return ensureAndReadRemaining();
};

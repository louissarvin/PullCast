/**
 * Atomic token-bucket rate limiter backed by Postgres.
 *
 * The schema-review (R4) flagged the classic find-then-update race for hot
 * RateLimitBucket rows. This module is the single place where the bucket is
 * mutated, and it uses one atomic SQL statement so concurrent callers cannot
 * over-spend tokens.
 *
 * Pattern:
 *   INSERT INTO "RateLimitBucket" ...
 *   ON CONFLICT (bucket_key) DO UPDATE
 *     SET tokens_remaining = LEAST(
 *           capacity,
 *           tokens_remaining + FLOOR(seconds_elapsed / 60 * refill_per_minute)::int
 *         ) - 1,
 *         last_refill_at = NOW()
 *     WHERE tokens_remaining > 0
 *        OR seconds_elapsed >= 60.0 / refill_per_minute
 *   RETURNING tokens_remaining;
 *
 * If RETURNING yields a row, the call won a token. If not, the bucket is
 * exhausted; the caller MUST back off.
 */

import { nanoid } from 'nanoid';

import { Prisma } from '../../prisma/generated/client.js';
import { prismaQuery } from './prisma.ts';

const LOG_PREFIX = '[rate-limit]';

interface BucketRow {
  tokens_remaining: number;
}

/**
 * Atomic token consumption. Returns true if the caller may proceed, false if
 * the bucket is exhausted (or the underlying DB is unreachable - we fail
 * CLOSED to protect upstream services).
 *
 * @param bucketKey Stable identifier, e.g. `discord:channel:<id>` or `http:ip:<ip>`.
 * @param capacity Max tokens the bucket holds.
 * @param refillPerMinute Tokens added per minute (linear refill).
 */
export const consumeRateLimitToken = async (
  bucketKey: string,
  capacity: number,
  refillPerMinute: number
): Promise<boolean> => {
  if (typeof bucketKey !== 'string' || bucketKey.length === 0) {
    console.warn(`${LOG_PREFIX} consumeRateLimitToken called with empty bucketKey`);
    return false;
  }
  if (!Number.isFinite(capacity) || capacity <= 0) {
    console.warn(`${LOG_PREFIX} invalid capacity=${capacity} bucket=${bucketKey}`);
    return false;
  }
  if (!Number.isFinite(refillPerMinute) || refillPerMinute <= 0) {
    console.warn(`${LOG_PREFIX} invalid refillPerMinute=${refillPerMinute} bucket=${bucketKey}`);
    return false;
  }

  try {
    // Initial row inserts with tokens=capacity-1 (one token consumed on first
    // call). On conflict, refill linearly from lastRefillAt and decrement by 1
    // ONLY if (a) tokens > 0 OR (b) enough time has elapsed for >= 1 refill.
    //
    // `id` is generated in JS (the Prisma schema uses cuid() defaults; raw SQL
    // bypasses that, so we supply a stable string id ourselves). nanoid is
    // already a project dependency.
    const newId = nanoid();
    const rows = await prismaQuery.$queryRaw<BucketRow[]>(Prisma.sql`
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
        ${bucketKey},
        ${capacity - 1},
        ${capacity},
        ${refillPerMinute},
        NOW(),
        NOW(),
        NOW()
      )
      ON CONFLICT ("bucketKey") DO UPDATE
      SET "tokensRemaining" = LEAST(
            "RateLimitBucket"."capacity",
            "RateLimitBucket"."tokensRemaining"
              + FLOOR(EXTRACT(EPOCH FROM (NOW() - "RateLimitBucket"."lastRefillAt"))
                  / 60.0 * "RateLimitBucket"."refillPerMinute")::int
          ) - 1,
          "lastRefillAt" = NOW(),
          "updatedAt"    = NOW()
      WHERE "RateLimitBucket"."tokensRemaining" > 0
         OR EXTRACT(EPOCH FROM (NOW() - "RateLimitBucket"."lastRefillAt"))
            >= 60.0 / NULLIF("RateLimitBucket"."refillPerMinute", 0)
      RETURNING "tokensRemaining" AS tokens_remaining;
    `);

    if (rows.length === 0) {
      // Conflict triggered but WHERE clause filtered the UPDATE out.
      // Bucket is exhausted; caller must back off.
      return false;
    }

    // Defensive: if for any reason the computed remaining is negative, treat
    // as exhausted. (Should never happen given the WHERE guard.)
    const remaining = Number(rows[0].tokens_remaining);
    if (!Number.isFinite(remaining) || remaining < 0) {
      console.warn(
        `${LOG_PREFIX} unexpected negative tokens_remaining=${remaining} bucket=${bucketKey}`
      );
      return false;
    }
    return true;
  } catch (err) {
    // Fail CLOSED on infra errors. If the DB is down we would rather drop a
    // post than spam a channel into a ban.
    console.error(`${LOG_PREFIX} consume failed bucket=${bucketKey}:`, err);
    return false;
  }
};


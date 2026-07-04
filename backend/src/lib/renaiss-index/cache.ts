import { prismaQuery } from '../prisma.ts';
import { renaissIndex } from './client.ts';
import { assertDailyBudget } from './budget.ts';
import { indexGradedSchema } from './schemas.ts';
import { INDEX_BETA_DISCLOSURE, type IndexGraded } from './types.ts';

const LOG_PREFIX = '[renaiss-index]';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const hydrateFromRow = (row: { payloadJson: string }): IndexGraded | null => {
  try {
    const parsed: unknown = JSON.parse(row.payloadJson);
    const validated = indexGradedSchema.safeParse(parsed);
    if (!validated.success) {
      console.warn(`${LOG_PREFIX} cache row failed schema validation:`, validated.error.message);
      return null;
    }
    // Ensure disclosure is set even on rows written before the field was added.
    return { ...validated.data, _disclosure: INDEX_BETA_DISCLOSURE };
  } catch (err) {
    console.warn(`${LOG_PREFIX} cache row JSON parse failed:`, err);
    return null;
  }
};

/**
 * Read-through cache for /v1/graded/{cert}.
 *
 * Hit:  returns cached IndexGraded immediately.
 * Miss: calls the API (after asserting daily budget), upserts the row, returns.
 *
 * Failure semantics:
 *   - Cache READ failure -> log + treat as miss (do not throw).
 *   - Cache WRITE failure -> log + return the freshly-fetched value anyway.
 *   - API failure -> rethrow so caller can decide (often: fall back to "found:false").
 */
export const getOrFetchCert = async (
  cert: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<IndexGraded> => {
  const now = new Date();

  let cached: IndexGraded | null = null;
  try {
    const row = await prismaQuery.certCache.findUnique({ where: { cert } });
    if (row && row.deletedAt === null && row.expiresAt > now) {
      cached = hydrateFromRow(row);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} cache read failed for cert=${cert}:`, err);
  }

  if (cached) {
    return cached;
  }

  await assertDailyBudget();
  const fresh = await renaissIndex.getGradedByCert(cert);

  // Persist asynchronously. Do not block the response on this.
  const expiresAt = new Date(now.getTime() + ttlMs);
  const fmvUsdCents = fresh.card?.priceUsdCents ?? null;
  const confidence = fresh.card?.confidence ?? null;
  const lastSaleAt = fresh.card?.lastSaleAt ? new Date(fresh.card.lastSaleAt) : null;

  prismaQuery.certCache
    .upsert({
      where: { cert },
      create: {
        cert,
        found: fresh.found,
        reason: fresh.reason ?? null,
        payloadJson: JSON.stringify(fresh),
        fmvUsdCents,
        confidence,
        lastSaleAt,
        fetchedAt: now,
        expiresAt,
      },
      update: {
        found: fresh.found,
        reason: fresh.reason ?? null,
        payloadJson: JSON.stringify(fresh),
        fmvUsdCents,
        confidence,
        lastSaleAt,
        fetchedAt: now,
        expiresAt,
        deletedAt: null,
      },
    })
    .catch((err: unknown) => {
      console.warn(`${LOG_PREFIX} cache write failed for cert=${cert}:`, err);
    });

  return fresh;
};

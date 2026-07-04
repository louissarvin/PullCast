/**
 * Atomic Pull upsert with insert-vs-existing flag.
 *
 * The prior implementation (`prismaQuery.pull.upsert` + a `createdAt`-drift
 * heuristic) could not reliably distinguish a true insert from an idempotent
 * no-op on the existing row. That mattered for the fanout decision: we must
 * post to Discord ONLY when the row is freshly inserted, never when an
 * indexer re-tick sees the same token again.
 *
 * Pattern (one round-trip, atomic):
 *
 *   WITH inserted AS (
 *     INSERT INTO "Pull" (...) VALUES (...)
 *     ON CONFLICT ("packSlug", "collectibleTokenId") DO NOTHING
 *     RETURNING *
 *   )
 *   SELECT *, TRUE AS __was_inserted FROM inserted
 *   UNION ALL
 *   SELECT *, FALSE AS __was_inserted FROM "Pull"
 *   WHERE "packSlug" = $X AND "collectibleTokenId" = $Y
 *     AND NOT EXISTS (SELECT 1 FROM inserted);
 *
 * If the row was inserted, the CTE returns the new row + `__was_inserted=true`.
 * Otherwise the second SELECT returns the EXISTING row + `__was_inserted=false`.
 * Exactly one row comes back either way.
 *
 * All values go through `Prisma.sql` parameterized templating; no string
 * concatenation. The unique index `uq_pull_pack_token` is the conflict target.
 */

import { nanoid } from 'nanoid';

import { Prisma, type Pull } from '../../../prisma/generated/client.js';
import { prismaQuery } from '../prisma.ts';

const LOG_PREFIX = '[pull-upsert]';

export interface PullUpsertInput {
  packSlug: string;
  collectibleTokenId: string;
  buyerAddress: string;
  tier: string | null;
  fmvUsdCents: number | null;
  packPriceUsdCents: number;
  netGainUsdCents: number | null;
  pulledAtTimestamp: Date;
  txHash: string | null;
  blockNumber: number | null;
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  gradingCompany: string | null;
  grade: string | null;
  serial: string | null;
  frontImageUrl: string | null;
  backImageUrl: string | null;
  rawAttributesJson: string | null;
}

export interface PullUpsertResult {
  pull: Pull;
  isInsert: boolean;
}

/**
 * Raw row shape returned by the CTE query. Column names match the Postgres
 * quoted identifiers (camelCase, matching the Prisma schema). The
 * `__was_inserted` flag is added by the SELECT.
 */
interface RawPullRow {
  id: string;
  packSlug: string;
  collectibleTokenId: string;
  buyerAddress: string;
  tier: string | null;
  fmvUsdCents: number | null;
  packPriceUsdCents: number;
  netGainUsdCents: number | null;
  pulledAtTimestamp: Date;
  txHash: string | null;
  blockNumber: number | null;
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  gradingCompany: string | null;
  grade: string | null;
  serial: string | null;
  frontImageUrl: string | null;
  backImageUrl: string | null;
  rawAttributesJson: string | null;
  shareCardPostedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  __was_inserted: boolean;
}

const toPull = (row: RawPullRow): Pull => ({
  id: row.id,
  packSlug: row.packSlug,
  collectibleTokenId: row.collectibleTokenId,
  buyerAddress: row.buyerAddress,
  tier: row.tier,
  fmvUsdCents: row.fmvUsdCents,
  packPriceUsdCents: row.packPriceUsdCents,
  netGainUsdCents: row.netGainUsdCents,
  pulledAtTimestamp: row.pulledAtTimestamp,
  txHash: row.txHash,
  blockNumber: row.blockNumber,
  cardName: row.cardName,
  setName: row.setName,
  cardNumber: row.cardNumber,
  gradingCompany: row.gradingCompany,
  grade: row.grade,
  serial: row.serial,
  frontImageUrl: row.frontImageUrl,
  backImageUrl: row.backImageUrl,
  rawAttributesJson: row.rawAttributesJson,
  shareCardPostedAt: row.shareCardPostedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deletedAt: row.deletedAt,
});

/**
 * Atomic insert-if-absent for Pull. Returns the row (newly inserted OR existing)
 * plus a definitive isInsert flag. The flag is the source of truth for whether
 * the indexer should fan out a Discord share-card post.
 *
 * First-write-wins semantics: on conflict, the existing row is returned
 * unmodified. The caller's freshly-fetched FMV / metadata is discarded for
 * idempotency.
 */
export const upsertPullReturningInsertFlag = async (
  input: PullUpsertInput
): Promise<PullUpsertResult> => {
  // Generate an id client-side because raw SQL bypasses Prisma's @default(cuid()).
  // nanoid is the project-standard id generator (see rate-limit.ts). If the row
  // already exists this id is discarded by the ON CONFLICT branch; the existing
  // id is returned via the second SELECT.
  const newId = nanoid();
  const rows = await prismaQuery.$queryRaw<RawPullRow[]>(Prisma.sql`
    WITH inserted AS (
      INSERT INTO "Pull" (
        "id",
        "packSlug",
        "collectibleTokenId",
        "buyerAddress",
        "tier",
        "fmvUsdCents",
        "packPriceUsdCents",
        "netGainUsdCents",
        "pulledAtTimestamp",
        "txHash",
        "blockNumber",
        "cardName",
        "setName",
        "cardNumber",
        "gradingCompany",
        "grade",
        "serial",
        "frontImageUrl",
        "backImageUrl",
        "rawAttributesJson",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${newId},
        ${input.packSlug},
        ${input.collectibleTokenId},
        ${input.buyerAddress},
        ${input.tier},
        ${input.fmvUsdCents},
        ${input.packPriceUsdCents},
        ${input.netGainUsdCents},
        ${input.pulledAtTimestamp},
        ${input.txHash},
        ${input.blockNumber},
        ${input.cardName},
        ${input.setName},
        ${input.cardNumber},
        ${input.gradingCompany},
        ${input.grade},
        ${input.serial},
        ${input.frontImageUrl},
        ${input.backImageUrl},
        ${input.rawAttributesJson},
        NOW(),
        NOW()
      )
      ON CONFLICT ("packSlug", "collectibleTokenId") DO NOTHING
      RETURNING *
    )
    SELECT *, TRUE AS "__was_inserted" FROM inserted
    UNION ALL
    SELECT *, FALSE AS "__was_inserted" FROM "Pull"
    WHERE "packSlug" = ${input.packSlug}
      AND "collectibleTokenId" = ${input.collectibleTokenId}
      AND NOT EXISTS (SELECT 1 FROM inserted)
    LIMIT 1;
  `);

  if (rows.length === 0) {
    // Should be impossible: either the INSERT lands, or the row already exists
    // and the second branch returns it. If the conflict-target row was soft-
    // deleted between the INSERT and the SELECT we could land here.
    throw new Error(
      `${LOG_PREFIX} upsert returned zero rows pack=${input.packSlug} token=${input.collectibleTokenId}`
    );
  }

  const row = rows[0];
  return {
    pull: toPull(row),
    isInsert: row.__was_inserted === true,
  };
};

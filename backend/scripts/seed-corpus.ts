/**
 * One-shot seed script. Upserts the static `CORPUS_SEEDS` array from
 * `src/lib/anthropic/corpus-seeds.ts` into the `AnthropicCorpus` Postgres
 * table using the (sourceUrl, chunkIndex) composite unique.
 *
 * Idempotent: re-running updates changed excerpts / titles / tags without
 * touching createdAt.
 *
 * Prereqs (user runs these; script does NOT):
 *   1. bun run db:push       # apply schema (adds AnthropicCorpus)
 *   2. bun run db:generate   # regenerate Prisma client
 *
 * Usage: bun run seed-corpus
 */

import { CORPUS_SEEDS } from '../src/lib/anthropic/corpus-seeds.ts';
import { prismaQuery } from '../src/lib/prisma.ts';

const LOG_PREFIX = '[seed-corpus]';

interface PrismaLike {
  anthropicCorpus?: {
    upsert: (args: {
      where: { sourceUrl_chunkIndex: { sourceUrl: string; chunkIndex: number } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => Promise<unknown>;
    count: () => Promise<number>;
  };
  $disconnect: () => Promise<void>;
}

const main = async (): Promise<void> => {
  const client = prismaQuery as unknown as PrismaLike;

  if (typeof client.anthropicCorpus?.upsert !== 'function') {
    console.error(
      `${LOG_PREFIX} FATAL: prisma client has no AnthropicCorpus model. Did you run \`bun run db:push\` + \`bun run db:generate\` after schema changes?`
    );
    process.exit(1);
  }

  console.log(`${LOG_PREFIX} starting seed of ${CORPUS_SEEDS.length} chunks`);

  let inserted = 0;
  let updated = 0;
  let failed = 0;

  for (const seed of CORPUS_SEEDS) {
    try {
      const publishedAt = seed.publishedAt
        ? new Date(`${seed.publishedAt}T00:00:00Z`)
        : null;
      const tagsCsv = seed.tags.join(',');

      // Detect insert-vs-update by pre-checking existence via a lightweight
      // upsert.update with a trivial change guard is not portable across
      // Prisma versions; we use two-step here to keep counts accurate without
      // depending on affected-row metadata.
      const existing = await (
        prismaQuery as unknown as {
          anthropicCorpus: {
            findUnique: (args: {
              where: { sourceUrl_chunkIndex: { sourceUrl: string; chunkIndex: number } };
            }) => Promise<unknown>;
          };
        }
      ).anthropicCorpus.findUnique({
        where: {
          sourceUrl_chunkIndex: {
            sourceUrl: seed.sourceUrl,
            chunkIndex: seed.chunkIndex,
          },
        },
      });

      await client.anthropicCorpus.upsert({
        where: {
          sourceUrl_chunkIndex: {
            sourceUrl: seed.sourceUrl,
            chunkIndex: seed.chunkIndex,
          },
        },
        create: {
          seedId: seed.id,
          title: seed.title,
          sourceUrl: seed.sourceUrl,
          publishedAt,
          category: seed.category,
          chunkIndex: seed.chunkIndex,
          excerpt: seed.excerpt,
          tokensEstimated: seed.tokensEstimated,
          tagsCsv,
        },
        update: {
          seedId: seed.id,
          title: seed.title,
          publishedAt,
          category: seed.category,
          excerpt: seed.excerpt,
          tokensEstimated: seed.tokensEstimated,
          tagsCsv,
          deletedAt: null, // re-seed always un-soft-deletes
        },
      });

      if (existing === null) {
        inserted += 1;
        console.log(`${LOG_PREFIX} +  ${seed.id}  ${seed.sourceUrl}#${seed.chunkIndex}`);
      } else {
        updated += 1;
        console.log(`${LOG_PREFIX} ~  ${seed.id}  ${seed.sourceUrl}#${seed.chunkIndex}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`${LOG_PREFIX} !  ${seed.id}: ${(err as Error).message}`);
    }
  }

  const total = await client.anthropicCorpus.count();
  console.log(
    `${LOG_PREFIX} done inserted=${inserted} updated=${updated} failed=${failed} totalRows=${total}`
  );

  await client.$disconnect();
  if (failed > 0) process.exit(1);
};

main().catch(async (err: unknown) => {
  console.error(`${LOG_PREFIX} unhandled:`, err);
  const client = prismaQuery as unknown as PrismaLike;
  await client.$disconnect().catch(() => undefined);
  process.exit(1);
});

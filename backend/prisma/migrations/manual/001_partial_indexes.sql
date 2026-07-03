-- PullCast manual partial-index migration
-- Run AFTER `bun run db:push`. Apply via psql, NOT through Prisma:
--   psql "$DATABASE_URL" -f prisma/migrations/manual/001_partial_indexes.sql
--
-- Why a separate file:
--   1. Prisma does not support partial indexes declaratively.
--   2. CREATE INDEX CONCURRENTLY cannot run inside a transaction. Prisma migrate
--      wraps statements in BEGIN/COMMIT by default; this file is executed as
--      individual statements so CONCURRENTLY works.
--
-- All statements are idempotent (IF NOT EXISTS).
-- All indexes are additive. No DROP, no NOT NULL adds, no column rename.

-- ---------------------------------------------------------------------------
-- B3: Hot-path read partial composites for Pull
-- ---------------------------------------------------------------------------
-- Q: /api/wallets/:address/pulls
-- WHERE buyer_address = $1 AND deleted_at IS NULL
-- ORDER BY pulled_at_timestamp DESC LIMIT 50
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pull_buyer_pulled_active
  ON "Pull" (buyer_address, pulled_at_timestamp DESC)
  WHERE deleted_at IS NULL;

-- Q: /api/pulls (global JSON feed)
-- WHERE deleted_at IS NULL
-- ORDER BY pulled_at_timestamp DESC LIMIT 100
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pull_pulled_active
  ON "Pull" (pulled_at_timestamp DESC)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- B1: Subscription scope uniqueness via partial unique indexes
-- ---------------------------------------------------------------------------
-- Prisma 7.2 does not yet support nullsNotDistinct on @@unique. Subscription
-- has wallet-scoped XOR pack-scoped semantics, so exactly one of those columns
-- is always NULL. We enforce the two scopes as separate partial uniques.
-- Includes deleted_at IS NULL so a deleted+recreated subscription is allowed.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_sub_wallet_scope
  ON "Subscription" (discord_channel_id, wallet_address)
  WHERE pack_slug IS NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_sub_pack_scope
  ON "Subscription" (discord_channel_id, pack_slug)
  WHERE wallet_address IS NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- R1: Subscription fanout partial indexes
-- ---------------------------------------------------------------------------
-- Q: Per-Pull fanout
-- WHERE (wallet_address = $1 OR pack_slug = $2) AND deleted_at IS NULL
-- Splitting into two partials keeps each index tiny since every row has
-- exactly one of walletAddress / packSlug set.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sub_wallet_active
  ON "Subscription" (wallet_address)
  WHERE deleted_at IS NULL AND wallet_address IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sub_pack_active
  ON "Subscription" (pack_slug)
  WHERE deleted_at IS NULL AND pack_slug IS NOT NULL;

-- ---------------------------------------------------------------------------
-- R2 partial: CertCache refresh worker scan
-- ---------------------------------------------------------------------------
-- Q: SELECT FROM "CertCache" WHERE expires_at < NOW() AND deleted_at IS NULL
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_certcache_expires_active
  ON "CertCache" (expires_at)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- R6: Pull.serial partial uniqueness (one cert maps to one slab globally)
-- ---------------------------------------------------------------------------
-- Promotes the schema's @@index([serial]) to a partial unique. Loud failure on
-- duplicate cert lookup is preferable to silent data integrity bugs.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_pull_serial_active
  ON "Pull" (serial)
  WHERE serial IS NOT NULL AND deleted_at IS NULL;

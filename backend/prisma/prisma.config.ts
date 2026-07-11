import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// @ts-ignore - Prisma 7 config options
export default defineConfig({
  earlyAccess: true,
  schema: './schema.prisma',
  datasource: {
    // DATABASE_URL is used for runtime queries. Point at Supabase's Session
    // Pooler on port 5432 (or the Transaction Pooler on 6543 with
    // ?pgbouncer=true&connection_limit=1 if you need serverless concurrency).
    url: process.env.DATABASE_URL!,
    // DIRECT_URL is used ONLY for migrations (db push, migrate deploy).
    // Point at a direct Supabase connection (db.PROJECT.supabase.co:5432) or
    // the Session Pooler URL. Never the Transaction Pooler on 6543 — PgBouncer
    // in transaction mode does not support DDL. Falls back to DATABASE_URL
    // if DIRECT_URL is not set, so existing single-URL setups keep working.
    directUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
  },
});

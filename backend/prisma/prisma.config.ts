import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7 config. In Prisma 7 the datasource `url` no longer lives in
// schema.prisma — it must be declared here. See
// https://pris.ly/d/prisma7-client-config
//
// DATABASE_URL should point at Supabase's Session Pooler on port 5432
// (recommended) which supports both prepared statements and DDL. Do NOT use
// the Transaction Pooler on 6543 for migrations because PgBouncer in
// transaction mode rejects DDL.
// @ts-ignore - Prisma 7 config options
export default defineConfig({
  earlyAccess: true,
  schema: './schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});

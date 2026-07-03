import { PrismaClient } from '../../prisma/generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { DATABASE_URL } from '../config/main-config.ts';

const adapter = new PrismaPg({
  connectionString: DATABASE_URL,
});

export const prismaQuery = new PrismaClient({ adapter });

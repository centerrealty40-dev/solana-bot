import 'dotenv/config';
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/core/db/schema.ts',
  out: './src/core/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.SA_PG_DSN || process.env.DATABASE_URL || 'postgresql://localhost:5432/postgres',
  },
  strict: true,
  verbose: true,
} satisfies Config;

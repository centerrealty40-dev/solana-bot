import 'dotenv/config';
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/core/db/schema.ts',
  out: './src/core/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
} satisfies Config;

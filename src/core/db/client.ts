import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { config } from '../config.js';
import * as schema from './schema.js';

/**
 * Single shared Postgres connection for the process.
 * Note: postgres-js has its own pool. For long-running services we want max ~10
 * to stay polite to Neon's free tier connection limits.
 */
const queryClient = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: false,
});

export const db = drizzle(queryClient, { schema });
export type DB = typeof db;
export { schema };
export const sql = queryClient;

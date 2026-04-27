import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db } from '../core/db/client.js';
import { child } from '../core/logger.js';

const log = child('migrate');

async function main(): Promise<void> {
  log.info('running migrations');
  await migrate(db, { migrationsFolder: './src/core/db/migrations' });
  log.info('migrations done');
  process.exit(0);
}

main().catch((err) => {
  log.error({ err }, 'migration failed');
  process.exit(1);
});

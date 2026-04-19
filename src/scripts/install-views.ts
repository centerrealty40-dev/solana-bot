import { readFile } from 'node:fs/promises';
import { sql } from '../core/db/client.js';
import { child } from '../core/logger.js';

const log = child('install-views');

async function main(): Promise<void> {
  const file = await readFile('./src/dashboard/views.sql', 'utf-8');
  await sql.unsafe(file);
  log.info('dashboard views installed');
  process.exit(0);
}

main().catch((err) => {
  log.error({ err }, 'install-views failed');
  process.exit(1);
});

import fs from 'node:fs';
import path from 'node:path';
import { main } from '../live/main.js';

const LAST_FATAL_PATH = path.join(process.cwd(), 'data/live/last-fatal.json');

function writeLiveOscarFatal(source: string, err: unknown): void {
  try {
    fs.mkdirSync(path.dirname(LAST_FATAL_PATH), { recursive: true });
    const payload = {
      ts: Date.now(),
      source,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
    fs.writeFileSync(LAST_FATAL_PATH, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (werr) {
    console.error('live-oscar: failed to write data/live/last-fatal.json', werr);
  }
}

process.on('uncaughtException', (err) => {
  writeLiveOscarFatal('uncaughtException', err);
  console.error('live-oscar uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  writeLiveOscarFatal('unhandledRejection', reason);
  console.error('live-oscar unhandledRejection', reason);
});

main().catch((err) => {
  writeLiveOscarFatal('main', err);
  console.error('live-oscar fatal', err);
  process.exit(1);
});

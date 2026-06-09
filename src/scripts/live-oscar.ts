import fs from 'node:fs';
import path from 'node:path';
import { startOpsHeartbeat } from '../core/ops-heartbeat.js';
import { main } from '../live/main.js';

const sid = process.env.LIVE_STRATEGY_ID?.trim() || 'live-oscar';
const LAST_FATAL_PATH = path.join(process.cwd(), 'data/live', `last-fatal-${sid}.json`);

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
    console.error(`live-oscar: failed to write ${LAST_FATAL_PATH}`, werr);
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

startOpsHeartbeat({ appName: 'live-oscar' });

main().catch((err) => {
  writeLiveOscarFatal('main', err);
  console.error('live-oscar fatal', err);
  process.exit(1);
});

import fs from 'node:fs';
import path from 'node:path';
import { startOpsHeartbeat } from '../core/ops-heartbeat.js';
import { main } from '../live/main.js';
import { LIVE_OSCAR_PRESET_C_STRATEGY_ID } from '../preset-c/live-oscar-family.js';

const sid = process.env.LIVE_STRATEGY_ID?.trim() || LIVE_OSCAR_PRESET_C_STRATEGY_ID;
const LAST_FATAL_PATH = path.join(process.cwd(), 'data/live', `last-fatal-${sid}.json`);

function writeFatal(source: string, err: unknown): void {
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
    console.error(`live-oscar-preset-c: failed to write ${LAST_FATAL_PATH}`, werr);
  }
}

process.on('uncaughtException', (err) => {
  writeFatal('uncaughtException', err);
  console.error('live-oscar-preset-c uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  writeFatal('unhandledRejection', reason);
  console.error('live-oscar-preset-c unhandledRejection', reason);
});

startOpsHeartbeat({ appName: LIVE_OSCAR_PRESET_C_STRATEGY_ID });

main().catch((err) => {
  writeFatal('main', err);
  console.error('live-oscar-preset-c fatal', err);
  process.exit(1);
});

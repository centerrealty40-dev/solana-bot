/**
 * Stealth copy-trader — следит за одним кошельком, вход с задержкой + оценка, выход с jitter.
 *
 *   npm run copy-trader
 *
 * Env: COPY_TRADER_* (см. .env.example).
 */
import { loadCopyTraderConfig } from '../copytrader/config.js';
import { runCopyTraderLoop } from '../copytrader/main.js';
import { startOpsHeartbeat, writeOpsFatal } from '../core/ops-heartbeat.js';

function fatalExit(err: unknown, source: string): never {
  writeOpsFatal('copy-trader', source, err);
  console.error(`[copy-trader] ${source}`, err);
  process.exit(1);
}

process.on('uncaughtException', (err) => fatalExit(err, 'uncaughtException'));
process.on('unhandledRejection', (err) => fatalExit(err, 'unhandledRejection'));

async function main(): Promise<void> {
  const cfg = loadCopyTraderConfig();
  startOpsHeartbeat({ appName: 'copy-trader' });
  await runCopyTraderLoop(cfg);
}

main().catch((err) => fatalExit(err, 'fatal'));

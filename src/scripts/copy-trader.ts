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

/** Several copy-trader instances can run side by side; ops files must not collide. */
function appName(): string {
  const raw = process.env.COPY_TRADER_APP_NAME?.trim();
  return raw && /^[a-z0-9._-]{1,64}$/i.test(raw) ? raw : 'copy-trader';
}

function fatalExit(err: unknown, source: string): never {
  writeOpsFatal(appName(), source, err);
  console.error(`[${appName()}] ${source}`, err);
  process.exit(1);
}

process.on('uncaughtException', (err) => fatalExit(err, 'uncaughtException'));
process.on('unhandledRejection', (err) => fatalExit(err, 'unhandledRejection'));

async function main(): Promise<void> {
  const cfg = loadCopyTraderConfig();
  startOpsHeartbeat({ appName: appName() });
  await runCopyTraderLoop(cfg);
}

main().catch((err) => fatalExit(err, 'fatal'));

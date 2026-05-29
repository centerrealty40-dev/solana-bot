/**
 * Stealth copy-trader — следит за одним кошельком, вход с задержкой + оценка, выход с jitter.
 *
 *   npm run copy-trader
 *
 * Env: COPY_TRADER_* (см. .env.example).
 */
import { loadCopyTraderConfig } from '../copytrader/config.js';
import { runCopyTraderLoop } from '../copytrader/main.js';

async function main(): Promise<void> {
  const cfg = loadCopyTraderConfig();
  await runCopyTraderLoop(cfg);
}

main().catch((err) => {
  console.error('[copy-trader] fatal', err);
  process.exit(1);
});

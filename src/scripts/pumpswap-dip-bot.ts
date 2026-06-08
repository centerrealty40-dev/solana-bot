/**
 * PumpSwap dip bot — isolated from live-oscar / copy-trader / HL.
 *
 *   npm run pumpswap-dip-bot
 */
import { loadPumpswapDipConfig } from '../pumpswap-dip/config.js';
import { runPumpswapDipLoop } from '../pumpswap-dip/main.js';

async function main(): Promise<void> {
  const cfg = loadPumpswapDipConfig();
  await runPumpswapDipLoop(cfg);
}

main().catch((err) => {
  console.error('[pumpswap-dip] fatal', err);
  process.exit(1);
});

import { loadPumpswapComboConfig } from '../pumpswap-combo/config.js';
import { runPumpswapComboLoop } from '../pumpswap-combo/main.js';

const cfg = loadPumpswapComboConfig();
runPumpswapComboLoop(cfg).catch((e) => {
  console.error('[pumpswap-combo] fatal', e);
  process.exit(1);
});

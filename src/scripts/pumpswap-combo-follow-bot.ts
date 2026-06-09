import { loadPumpswapComboFollowConfig } from '../pumpswap-combo-follow/config.js';
import { runPumpswapComboFollowLoop } from '../pumpswap-combo-follow/main.js';

const cfg = loadPumpswapComboFollowConfig();
runPumpswapComboFollowLoop(cfg).catch((e) => {
  console.error('[pumpswap-combo-follow] fatal', e);
  process.exit(1);
});

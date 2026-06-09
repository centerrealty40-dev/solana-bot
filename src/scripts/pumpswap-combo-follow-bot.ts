import { loadPumpswapComboFollowConfig } from '../pumpswap-combo-follow/config.js';
import { runPumpswapComboFollowLoop } from '../pumpswap-combo-follow/main.js';
import { writeOpsFatal } from '../core/ops-heartbeat.js';

const cfg = loadPumpswapComboFollowConfig();
runPumpswapComboFollowLoop(cfg).catch((e) => {
  writeOpsFatal(cfg.strategyId, 'fatal', e);
  console.error('[pumpswap-combo-follow] fatal', e);
  process.exit(1);
});

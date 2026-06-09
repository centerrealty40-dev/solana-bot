import { loadPumpswapComboStreamConfig } from '../pumpswap-combo-stream/config.js';
import { runPumpswapComboStream } from '../pumpswap-combo-stream/main.js';

const cfg = loadPumpswapComboStreamConfig();
runPumpswapComboStream(cfg).catch((e) => {
  console.error('[pumpswap-combo-stream] fatal', e);
  process.exit(1);
});

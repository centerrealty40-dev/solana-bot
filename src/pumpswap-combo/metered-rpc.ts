import type { PumpswapComboConfig } from './config.js';
import { setComboRpcHook } from './pumpswap-direct.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let lastRpcAt = 0;

export async function comboRpcGap(cfg: PumpswapComboConfig): Promise<void> {
  const gap = Math.max(20, cfg.rpcMinGapMs);
  const wait = lastRpcAt + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastRpcAt = Date.now();
}

export function installComboRpcHooks(cfg: PumpswapComboConfig): void {
  if (!cfg.meteredRpcEnabled) {
    setComboRpcHook(null);
    return;
  }
  setComboRpcHook({ beforeCall: () => comboRpcGap(cfg) });
}

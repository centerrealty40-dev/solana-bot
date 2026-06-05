import type { HlTwapLiveConfig } from './config.js';
import { createDryRunClient } from './exchange-dry-run.js';
import { createHyperliquidClient } from './exchange-hyperliquid.js';
import type { HlTwapExchangeClient } from './types.js';

export async function createHlTwapExchangeClient(cfg: HlTwapLiveConfig): Promise<HlTwapExchangeClient> {
  const client =
    cfg.mode === 'live' && cfg.privateKey
      ? createHyperliquidClient(cfg)
      : createDryRunClient(cfg);
  await client.init();
  return client;
}

export type { HlTwapExchangeClient } from './types.js';

/**
 * Standalone HL TWAP live trader loop (dry-run or live).
 * Normally embedded in hl-twap-telegram-watch when HL_TWAP_LIVE_ENABLED=1.
 *
 * Env: see docs/platform/hl-twap-live-architecture.md
 */
import 'dotenv/config';

import { loadHyperliquidMarketCache } from '../hyperliquid/twap/hyperliquid-meta.js';
import { loadHlTwapLiveConfig } from '../hyperliquid/twap/live/config.js';
import { createHlTwapExchangeClient } from '../hyperliquid/twap/live/exchange-client.js';
import { processLiveLadders, processLiveTrades, processExchangeResiduals } from '../hyperliquid/twap/live/live-trader.js';

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const POLL_MS = Math.max(2000, envNum('HL_TWAP_POLL_INTERVAL_MS', 5000));
const META_REFRESH_MS = Math.max(30_000, envNum('HL_TWAP_META_REFRESH_MS', 120_000));
const ONCE = process.argv.includes('--once');

async function main(): Promise<void> {
  const cfg = loadHlTwapLiveConfig();
  if (!cfg.enabled) {
    console.error('[hl-twap-live-trader] Set HL_TWAP_LIVE_ENABLED=1');
    process.exit(1);
  }

  const client = await createHlTwapExchangeClient(cfg);
  console.log(
    `[hl-twap-live-trader] start mode=${client.mode} notional=$${cfg.notionalUsd} poll=${POLL_MS}ms`,
  );

  let cache = await loadHyperliquidMarketCache();
  let cacheAt = Date.now();

  const loop = async (): Promise<void> => {
    if (Date.now() - cacheAt >= META_REFRESH_MS) {
      try {
        cache = await loadHyperliquidMarketCache();
        cacheAt = Date.now();
      } catch (e) {
        console.warn('[hl-twap-live-trader] meta refresh failed', String(e));
      }
    }
    try {
      await processLiveTrades(cache, cfg, client);
      await processLiveLadders(cache, cfg, client);
      await processExchangeResiduals(cache, cfg, client);
    } catch (e) {
      console.warn('[hl-twap-live-trader] pass failed', String(e));
    }
    if (!ONCE) setTimeout(loop, POLL_MS);
  };

  await loop();
}

main().catch((e) => {
  console.error('[hl-twap-live-trader] fatal', e);
  process.exit(1);
});

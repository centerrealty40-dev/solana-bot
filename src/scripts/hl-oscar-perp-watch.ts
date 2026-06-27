/**
 * HyperLiquid Oscar dip-buy perp bot — paper/dry-run by default.
 *
 * Strategy: dip ≥10% from local high (2h/6h/12h) + impulse ≥12%, staged entry,
 * Wave B half8_runner exit (+8% sell 50%, trail +7.5%/2.5%, kill −50%).
 *
 * Env: HL_OSCAR_LIVE_ENABLED=0 (default paper), HL_OSCAR_* — see .env.example in hl-oscar-perp repo.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

import { loadHyperliquidMarketCache } from '../hyperliquid/twap/hyperliquid-meta.js';
import { createHlTwapExchangeClient } from '../hyperliquid/twap/live/exchange-client.js';
import { loadHlOscarPerpConfig, toHlTwapLiveConfig } from '../hyperliquid/oscar-perp/config.js';
import { initOscarDrawdownMonitor, runOscarDrawdownCheck } from '../hyperliquid/oscar-perp/drawdown.js';
import { writeHeartbeat } from '../hyperliquid/oscar-perp/journal.js';
import {
  createOscarTraderState,
  fetchOscarAccountEquity,
  runOscarTraderPass,
} from '../hyperliquid/oscar-perp/trader.js';
import {
  buildOscarUniverse,
  resolveOscarDenylist,
  resolveOscarWhitelist,
} from '../hyperliquid/oscar-perp/universe.js';

const LAST_FATAL_PATH =
  process.env.HL_OSCAR_LAST_FATAL_PATH?.trim() ||
  path.join(process.cwd(), 'data/hl-oscar-perp/last-fatal.json');

function writeLastFatal(err: unknown): void {
  try {
    fs.mkdirSync(path.dirname(LAST_FATAL_PATH), { recursive: true });
    const message = err instanceof Error ? err.stack || err.message : String(err);
    fs.writeFileSync(
      LAST_FATAL_PATH,
      `${JSON.stringify({ ts: Date.now(), source: 'hl-oscar-perp-watch', message: message.slice(0, 2000) })}\n`,
      'utf8',
    );
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  const cfg = loadHlOscarPerpConfig();
  if (!cfg.enabled) {
    console.log('[hl-oscar-perp] HL_OSCAR_ENABLED=0 — exit');
    return;
  }

  fs.mkdirSync(path.dirname(cfg.journalPath), { recursive: true });

  const twapCfg = toHlTwapLiveConfig(cfg);
  const client = await createHlTwapExchangeClient(twapCfg);
  const state = createOscarTraderState(cfg.journalPath);

  const denylist = resolveOscarDenylist();
  const whitelist = resolveOscarWhitelist();

  console.log(
    `[hl-oscar-perp] start mode=${client.mode} leverage=${cfg.leverage}x notional=$${cfg.positionNotionalUsd} legs=$${cfg.leg1GrossUsd}+$${cfg.leg2GrossUsd}+$${cfg.leg3GrossUsd} timeStop=${cfg.timeStopHours}h maxOpen=${cfg.maxOpenPositions}`,
  );
  console.log(
    `[hl-oscar-perp] denylist=${denylist.size} coins whitelist=${whitelist ? whitelist.size : 'all-except-deny'}`,
  );

  if (cfg.mode === 'live') {
    const equity = await fetchOscarAccountEquity(cfg.masterAddress);
    await initOscarDrawdownMonitor(cfg, equity);
  } else {
    console.log('[hl-oscar-perp] PAPER/DRY-RUN — set HL_OSCAR_LIVE_ENABLED=1 and HL_OSCAR_DRY_RUN=0 for live');
  }

  let lastDrawdownCheck = 0;
  let metaCache = await loadHyperliquidMarketCache();

  const tick = async (): Promise<void> => {
    try {
      if (Date.now() - metaCache.loadedAtMs > cfg.candleRefreshMs) {
        metaCache = await loadHyperliquidMarketCache();
      }
      const universe = buildOscarUniverse(metaCache, {
        minDayVolumeUsd: cfg.minDayVolumeUsd,
        denylist,
        whitelist,
      });

      if (cfg.mode === 'live' && Date.now() - lastDrawdownCheck >= cfg.drawdownCheckMs) {
        lastDrawdownCheck = Date.now();
        const equity = await fetchOscarAccountEquity(cfg.masterAddress);
        await runOscarDrawdownCheck(cfg, equity);
      }

      await runOscarTraderPass({
        cfg,
        client,
        cache: metaCache,
        universe,
        state,
      });

      writeHeartbeat(cfg.heartbeatPath, {
        openCount: state.opens.size,
        mode: client.mode,
        universeSize: universe.length,
      });
      console.log(
        `[hl-oscar-perp] tick ok opens=${state.opens.size} universe=${universe.length}`,
      );
    } catch (e) {
      console.error('[hl-oscar-perp] tick error', e);
      writeLastFatal(e);
    }
  };

  await tick();
  setInterval(tick, cfg.pollIntervalMs);
}

main().catch((e) => {
  writeLastFatal(e);
  console.error('[hl-oscar-perp] fatal', e);
  process.exit(1);
});

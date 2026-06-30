/**
 * HyperLiquid Oscar dip-buy perp bot — paper/dry-run by default.
 *
 * Strategy: dip ≥10% from local high (2h/6h/12h) + impulse ≥10%, staged entry 30/30/40 ($100 gross @ 2x),
 * leg2 −5% / leg3 −10% from signal; Wave B exit: TP +5%/+7.5%/+10%, trail from +5%, kill −45%.
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
import { countOscarOpensByMode, reconcileOscarOpensForLiveMode } from '../hyperliquid/oscar-perp/reconcile.js';
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
import {
  assertOscarTelegramBot,
  notifyOscarStartup,
  notifyOscarTelegramTest,
} from '../hyperliquid/oscar-perp/telegram-notify.js';

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
  if (process.argv.includes('--telegram-test')) {
    const ok = await notifyOscarTelegramTest();
    process.exit(ok ? 0 : 1);
  }

  const cfg = loadHlOscarPerpConfig();
  if (!cfg.enabled) {
    console.log('[hl-oscar-perp] HL_OSCAR_ENABLED=0 — exit');
    return;
  }

  if (cfg.mode === 'live') {
    await assertOscarTelegramBot();
  }

  fs.mkdirSync(path.dirname(cfg.journalPath), { recursive: true });

  const twapCfg = toHlTwapLiveConfig(cfg);
  const client = await createHlTwapExchangeClient(twapCfg);
  const state = createOscarTraderState(cfg.journalPath);

  if (cfg.mode === 'live') {
    await reconcileOscarOpensForLiveMode({ cfg, state });
  }

  const denylist = resolveOscarDenylist();
  const whitelist = resolveOscarWhitelist();

  const entryDesc = cfg.stagedEntryEnabled
    ? `staged legs=$${cfg.leg1GrossUsd}+$${cfg.leg2GrossUsd}+$${cfg.leg3GrossUsd} (total $${cfg.positionNotionalUsd})`
    : `single entry=$${cfg.leg1GrossUsd} gross ($${(cfg.leg1GrossUsd / cfg.leverage).toFixed(0)} margin @ ${cfg.leverage}x)`;
  console.log(
    `[hl-oscar-perp] start mode=${client.mode} leverage=${cfg.leverage}x ${entryDesc} timeStop=${cfg.timeStopHours > 0 ? `${cfg.timeStopHours}h` : 'off'} maxOpen=${cfg.maxOpenPositions}`,
  );
  console.log(
    `[hl-oscar-perp] denylist=${denylist.size} coins whitelist=${whitelist ? whitelist.size : 'all-except-deny'}`,
  );
  console.log(
    `[hl-oscar-perp] dip=${cfg.dipMinDropPct}% impulseMin=${cfg.dipMinImpulsePct}% leg2Drop=${cfg.leg2DropPct}% leg3Drop=${cfg.leg3DropPct}%`,
  );

  if (cfg.mode === 'live') {
    const equity = await fetchOscarAccountEquity(cfg.masterAddress);
    await initOscarDrawdownMonitor(cfg, equity);
    await notifyOscarStartup(cfg, client.mode);
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
        paperOpenCount: countOscarOpensByMode(state).paper,
        mode: cfg.mode,
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

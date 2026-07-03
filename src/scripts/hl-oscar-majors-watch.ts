/**
 * HyperLiquid Oscar Majors — Mode A knife (−6%) + Mode B scalp (−2%) for BTC+ETH.
 *
 * Env: HL_MAJORS_MODE=knife|scalp|both, HL_MAJORS_* (knife), HL_MAJORS_SCALP_* (scalp).
 * Scalp paper: HL_MAJORS_SCALP_DRY_RUN=1 (default) while knife may stay live.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

import { loadHyperliquidMarketCache } from '../hyperliquid/twap/hyperliquid-meta.js';
import { createHlTwapExchangeClient } from '../hyperliquid/twap/live/exchange-client.js';
import { loadHlOscarMajorsConfig, toHlTwapLiveConfig } from '../hyperliquid/oscar-majors/config.js';
import { initMajorsDrawdownMonitor, runMajorsDrawdownCheck } from '../hyperliquid/oscar-majors/drawdown.js';
import { writeHeartbeat } from '../hyperliquid/oscar-majors/journal.js';
import { countMajorsOpensByMode, reconcileMajorsWithHl } from '../hyperliquid/oscar-majors/reconcile.js';
import {
  createMajorsTraderState,
  fetchMajorsAccountEquity,
  runMajorsTraderPass,
} from '../hyperliquid/oscar-majors/trader.js';
import { buildMajorsUniverse } from '../hyperliquid/oscar-majors/universe.js';
import {
  assertMajorsTelegramBot,
  notifyMajorsStartup,
  notifyMajorsTelegramTest,
} from '../hyperliquid/oscar-majors/telegram-notify.js';

const LAST_FATAL_PATH =
  process.env.HL_MAJORS_LAST_FATAL_PATH?.trim() ||
  path.join(process.cwd(), 'data/hl-oscar-majors/last-fatal.json');

function writeLastFatal(err: unknown): void {
  try {
    fs.mkdirSync(path.dirname(LAST_FATAL_PATH), { recursive: true });
    const message = err instanceof Error ? err.stack || err.message : String(err);
    fs.writeFileSync(
      LAST_FATAL_PATH,
      `${JSON.stringify({ ts: Date.now(), source: 'hl-oscar-majors-watch', message: message.slice(0, 2000) })}\n`,
      'utf8',
    );
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--telegram-test')) {
    const ok = await notifyMajorsTelegramTest();
    process.exit(ok ? 0 : 1);
  }

  const cfg = loadHlOscarMajorsConfig();
  if (!cfg.enabled) {
    console.log('[hl-oscar-majors] HL_MAJORS_ENABLED=0 — exit');
    return;
  }

  if (cfg.mode === 'live') {
    await assertMajorsTelegramBot();
  }

  fs.mkdirSync(path.dirname(cfg.journalPath), { recursive: true });

  const twapCfg = toHlTwapLiveConfig(cfg);
  const client = await createHlTwapExchangeClient(twapCfg);
  const state = createMajorsTraderState(cfg.journalPath);

  if (cfg.mode === 'live') {
    const metaCache = await loadHyperliquidMarketCache();
    const universe = buildMajorsUniverse(metaCache, {
      minDayVolumeUsd: cfg.minDayVolumeUsd,
      whitelist: cfg.whitelist,
    });
    await reconcileMajorsWithHl({ cfg, client, state, universe, purgePaperOpens: true });
  }

  const entryDesc = cfg.stagedEntryEnabled
    ? `staged legs=$${cfg.leg1GrossUsd}+$${cfg.leg2GrossUsd}+$${cfg.leg3GrossUsd} (total $${cfg.positionNotionalUsd})`
    : `single entry=$${cfg.leg1GrossUsd} gross ($${(cfg.leg1GrossUsd / cfg.leverage).toFixed(0)} margin @ ${cfg.leverage}x)`;
  console.log(
    `[hl-oscar-majors] start strategyMode=${cfg.strategyMode} knifeMode=${client.mode} scalpMode=${cfg.scalp.mode} leverage=${cfg.leverage}x ${entryDesc} timeStop=${cfg.timeStopHours}h maxOpen=${cfg.maxOpenPositions}`,
  );
  console.log(
    `[hl-oscar-majors] whitelist=${cfg.whitelist.join(',')} knifeDip=${cfg.dipMinDropPct}% impulseMin=${cfg.dipMinImpulsePct}%`,
  );
  console.log(
    `[hl-oscar-majors] BTC TP=${cfg.btcTpRungs.join('/')} ETH TP=${cfg.ethTpRungs.join('/')}`,
  );
  if (cfg.strategyMode === 'scalp' || cfg.strategyMode === 'both') {
    const s = cfg.scalp;
    console.log(
      `[hl-oscar-majors] scalp dip=${s.dipPct}% window=${s.windowMin}m TP=${s.tpRungs.join('/')} SL=${s.slPct}% timeStop=${s.timeStopMin}m margin=$${s.marginUsd} gross=$${s.grossUsd} rangeMax=${s.rangeMaxPct ?? 'off'}`,
    );
  }

  if (cfg.mode === 'live') {
    const equity = await fetchMajorsAccountEquity(cfg.masterAddress);
    await initMajorsDrawdownMonitor(cfg, equity);
    await notifyMajorsStartup(cfg, client.mode);
  } else {
    console.log('[hl-oscar-majors] PAPER/DRY-RUN — set HL_MAJORS_LIVE_ENABLED=1 and HL_MAJORS_DRY_RUN=0 for live');
  }

  let lastDrawdownCheck = 0;
  let metaCache = await loadHyperliquidMarketCache();

  const tick = async (): Promise<void> => {
    try {
      if (Date.now() - metaCache.loadedAtMs > cfg.candleRefreshMs) {
        metaCache = await loadHyperliquidMarketCache();
      }
      const universe = buildMajorsUniverse(metaCache, {
        minDayVolumeUsd: cfg.minDayVolumeUsd,
        whitelist: cfg.whitelist,
      });

      if (cfg.mode === 'live' && Date.now() - lastDrawdownCheck >= cfg.drawdownCheckMs) {
        lastDrawdownCheck = Date.now();
        const equity = await fetchMajorsAccountEquity(cfg.masterAddress);
        await runMajorsDrawdownCheck(cfg, equity);
      }

      if (cfg.mode === 'live') {
        await reconcileMajorsWithHl({ cfg, client, state, universe });
      }

      await runMajorsTraderPass({
        cfg,
        client,
        cache: metaCache,
        universe,
        state,
      });

      writeHeartbeat(cfg.heartbeatPath, {
        openCount: state.opens.size,
        paperOpenCount: countMajorsOpensByMode(state).paper,
        mode: cfg.mode,
        strategyMode: cfg.strategyMode,
        scalpMode: cfg.scalp.mode,
        universeSize: universe.length,
      });
      console.log(
        `[hl-oscar-majors] tick ok opens=${state.opens.size} universe=${universe.length}`,
      );
    } catch (e) {
      console.error('[hl-oscar-majors] tick error', e);
      writeLastFatal(e);
    }
  };

  await tick();
  setInterval(tick, cfg.pollIntervalMs);
}

main().catch((e) => {
  writeLastFatal(e);
  console.error('[hl-oscar-majors] fatal', e);
  process.exit(1);
});

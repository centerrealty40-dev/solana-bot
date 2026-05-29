/**
 * dca_frontrun (paper) entrypoint.
 *
 * Loop: ingest qualified DCA opens (from the watcher's table) → run the paper engine
 * (score → enter after cycle 1 → average-down / take-profit / pre-exit → early-cancel)
 * → snapshot equity. Serves a private dashboard for inspection.
 *
 * PAPER ONLY. No private key is loaded; no transactions are ever signed or sent.
 */
import { dcabotConfig as cfg } from '../dcabot/config.js';
import { ensureDcabotTables } from '../dcabot/db.js';
import { ingestSignals } from '../dcabot/signals.js';
import { tickEngine } from '../dcabot/engine.js';
import { startDashboard } from '../dcabot/server.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!cfg.enabled) {
    console.log('[dcabot] disabled (DCABOT_ENABLED=0)');
    return;
  }
  if (!cfg.databaseUrl) {
    console.error('[dcabot] no DATABASE_URL / SA_PG_DSN — cannot start');
    process.exit(1);
  }

  await ensureDcabotTables();
  await startDashboard().catch((e) => console.error('[dcabot] dashboard failed to start', String(e).slice(0, 200)));

  console.log('[dcabot] paper engine started', {
    bank: cfg.bankUsd,
    minGainPct: cfg.minGainPct,
    baseEntryUsd: cfg.baseEntryUsd,
    avgDown: `${cfg.avgDownStepPct}%/$${cfg.avgDownUsd}`,
    takeProfit: `${cfg.tpStepPct}%/${cfg.tpSellFraction * 100}%`,
    exitCyclesBefore: `${cfg.exitFirstCyclesBefore}/${cfg.exitSecondCyclesBefore}`,
    bigCycleHoldUsd: cfg.bigCycleHoldUsd,
    tickMs: cfg.tickMs,
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const t0 = Date.now();
    try {
      await ingestSignals();
      await tickEngine();
    } catch (e) {
      console.error('[dcabot] loop error', String(e).slice(0, 200));
    }
    const elapsed = Date.now() - t0;
    await sleep(Math.max(1000, cfg.tickMs - elapsed));
  }
}

main().catch((e) => {
  console.error('[dcabot] fatal', e);
  process.exit(1);
});

import type { PumpswapComboConfig } from './config.js';
import { appendComboEvent } from './journal.js';
import { alertComboTradeLoss } from './alerts.js';
import { executeComboBuy, executeComboSell } from './executor.js';
import {
  applyPortfolioHalt,
  dipFromPosPeakPct,
  portfolioSnapshot,
  recordRealizedPnl,
  updateBotPeak,
} from './risk.js';
import { RollingHighTracker, inBand } from './rolling.js';
import {
  avgFillPrice,
  findPosition,
  investedUsd,
  isLossCooldownActive,
  pruneCooldowns,
  readComboState,
  setLossCooldown,
  writeComboState,
} from './state.js';
import { fetchComboWatchlist } from './watchlist.js';
import { pnlPctVsAvgFill, quoteExitPriceUsd, slPctForPosition } from './pricing.js';
import { comboLiveBridge } from './live-bridge.js';
import { configureLiveStore } from '../live/store-jsonl.js';
import { ensureComboSolUsd } from './sol-oracle.js';
import { getSolUsd } from '../papertrader/pricing.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function evaluateExits(cfg: PumpswapComboConfig): Promise<void> {
  await ensureComboSolUsd();
  const state = readComboState(cfg);
  const liveCfg = comboLiveBridge(cfg);
  const closedMints = new Set<string>();

  for (const pos of state.positions) {
    if (closedMints.has(pos.mint)) continue;

    const q = await quoteExitPriceUsd(liveCfg, pos.mint, pos.poolAddress);
    if (q.priceUsd == null) continue;

    updateBotPeak(pos, q.priceUsd);
    const pnlPct = pnlPctVsAvgFill(pos, q.priceUsd);
    const inv = investedUsd(pos);
    const slPct = slPctForPosition(cfg, pos);

    let action: 'tp1_partial' | 'tp2_full' | 'stop_loss' | null = null;
    if (pnlPct <= -slPct) {
      action = 'stop_loss';
    } else if (!pos.tp1Taken && pnlPct >= cfg.tp1Pct) {
      action = 'tp1_partial';
    } else if (pos.tp1Taken && pnlPct >= cfg.tp2Pct) {
      action = 'tp2_full';
    }

    if (!action) continue;

    const res = await executeComboSell({
      cfg,
      mint: pos.mint,
      symbol: pos.symbol,
      poolAddress: pos.poolAddress,
      markPriceUsd: q.priceUsd,
      investedUsd: inv,
      pnlPctAtMark: pnlPct,
      exitReason: action,
      intent: action,
      sellFrac: cfg.tp1SellFrac,
    });

    if (!res.ok) continue;

    if (action === 'tp1_partial') {
      pos.tp1Taken = true;
      continue;
    }

    closedMints.add(pos.mint);
    const realized = res.pnlUsd ?? inv * (pnlPct / 100);
    recordRealizedPnl(state, realized);

    if (realized < 0) {
      setLossCooldown(cfg, state, pos.mint, Date.now());
      void alertComboTradeLoss(cfg, {
        mint: pos.mint,
        symbol: pos.symbol,
        pnlUsd: realized,
        exitReason: action,
      });
    }

    appendComboEvent(cfg, {
      kind: 'round_trip',
      mint: pos.mint,
      symbol: pos.symbol,
      legs: pos.legs.length,
      investedUsd: inv,
      pnlUsd: realized,
      pnlPct,
      exitReason: action,
      holdSec: Math.round((Date.now() - pos.openedAt) / 1000),
    });
  }

  if (closedMints.size) {
    state.positions = state.positions.filter((p) => !closedMints.has(p.mint));
  }
  writeComboState(cfg, state);
}

async function evaluateEntries(
  cfg: PumpswapComboConfig,
  watchlist: Awaited<ReturnType<typeof fetchComboWatchlist>>,
  rolling: RollingHighTracker,
  nowMs: number,
): Promise<{ dumpBandCount: number; probeReadyCount: number }> {
  const state = readComboState(cfg);
  pruneCooldowns(state, nowMs);
  let dumpBandCount = 0;
  let probeReadyCount = 0;

  const snap = await portfolioSnapshot(cfg, state);
  if (applyPortfolioHalt(cfg, state, snap.totalPnlUsd)) {
    appendComboEvent(cfg, {
      kind: 'portfolio_halt',
      totalPnlUsd: snap.totalPnlUsd,
      limitUsd: cfg.portfolioStopLossUsd,
    });
    writeComboState(cfg, state);
    return { dumpBandCount, probeReadyCount };
  }

  if (state.halted) return { dumpBandCount, probeReadyCount };

  for (const row of watchlist) {
    rolling.push(row.mint, nowMs, row.priceUsd);
    const hi = row.high15mUsd;
    const currentDumpPct =
      hi > 0 && row.priceUsd > 0 ? ((hi - row.priceUsd) / hi) * 100 : null;
    if (currentDumpPct == null) continue;

    const pos = findPosition(state, row.mint);

    if (!pos) {
      if (state.positions.length >= cfg.maxConcurrentOpens) continue;
      if (!row.pairAddress) continue;
      if (isLossCooldownActive(state, row.mint, nowMs)) continue;
      if (!inBand(currentDumpPct, cfg.dumpMinPct, cfg.dumpMaxPct)) continue;
      if (row.low15mTs > 0 && nowMs - row.low15mTs > cfg.dumpFreshnessMs) continue;

      dumpBandCount++;

      const dipPeak = rolling.dipFromBotPeakPct(row.mint, row.priceUsd);
      if (dipPeak == null || dipPeak > cfg.probeMaxDipFromPeakPct) continue;
      probeReadyCount++;

      const buy = await executeComboBuy({
        cfg,
        mint: row.mint,
        symbol: row.symbol,
        poolAddress: row.pairAddress,
        signalPriceUsd: row.priceUsd,
        intent: 'probe',
        dumpPct: currentDumpPct,
        dipFromPeakPct: dipPeak,
      });
      if (!buy.ok || !(buy.fillPriceUsd && buy.fillPriceUsd > 0)) continue;

      state.positions.push({
        mint: row.mint,
        symbol: row.symbol,
        poolAddress: row.pairAddress,
        openedAt: nowMs,
        legs: [
          {
            ts: nowMs,
            usd: buy.usdAtMarket ?? cfg.legUsd,
            fillPriceUsd: buy.fillPriceUsd,
            txSignature: buy.txSignature,
          },
        ],
        botPeakUsd: Math.max(row.priceUsd, buy.fillPriceUsd),
        tp1Taken: false,
      });
      writeComboState(cfg, state);
      continue;
    }

    if (pos.legs.length >= cfg.maxBuyLegs) continue;
    const lastLegTs = pos.legs.at(-1)?.ts ?? 0;
    if (nowMs - lastLegTs < cfg.addMinGapMs) continue;

    updateBotPeak(pos, row.priceUsd);
    const dip = dipFromPosPeakPct(pos, row.priceUsd);
    if (dip == null || !inBand(dip, cfg.addDipMinPct, cfg.addDipMaxPct)) continue;

    const avg = avgFillPrice(pos);
    if (!(avg > 0) || row.priceUsd >= avg) continue;

    const buy = await executeComboBuy({
      cfg,
      mint: row.mint,
      symbol: row.symbol,
      poolAddress: pos.poolAddress || row.pairAddress,
      signalPriceUsd: row.priceUsd,
      intent: 'add',
      dipFromPeakPct: dip,
    });
    if (!buy.ok || !(buy.fillPriceUsd && buy.fillPriceUsd > 0)) continue;

    pos.legs.push({
      ts: nowMs,
      usd: buy.usdAtMarket ?? cfg.legUsd,
      fillPriceUsd: buy.fillPriceUsd,
      txSignature: buy.txSignature,
    });
    writeComboState(cfg, state);
  }
  return { dumpBandCount, probeReadyCount };
}

export async function runPumpswapComboLoop(cfg: PumpswapComboConfig): Promise<void> {
  configureLiveStore({ storePath: cfg.journalPath, strategyId: cfg.strategyId });
  const rolling = new RollingHighTracker(cfg.rollingHighWindowMs);
  let lastHeartbeat = 0;

  const solUsdBoot = await ensureComboSolUsd(true);

  appendComboEvent(cfg, {
    kind: 'boot',
    mode: 'autonomous',
    execVenue: 'pumpswap_direct',
    legUsd: cfg.legUsd,
    solUsd: solUsdBoot,
    portfolioStopLossUsd: cfg.portfolioStopLossUsd,
    dumpBand: `${cfg.dumpMinPct}-${cfg.dumpMaxPct}`,
    addDipBand: `${cfg.addDipMinPct}-${cfg.addDipMaxPct}`,
    tp1: `${cfg.tp1SellFrac * 100}%@${cfg.tp1Pct}%`,
    tp2: `@${cfg.tp2Pct}%`,
    slSingle: cfg.slSingleLegPct,
    slMulti: cfg.slMultiLegPct,
    slPreDca: cfg.slPreDcaPct,
    addMinGapMs: cfg.addMinGapMs,
    filters: {
      liq: cfg.minLiquidityUsd,
      vol5m: cfg.minVolume5mUsd,
      mcap: `${cfg.minMarketCapUsd}-${cfg.maxMarketCapUsd}`,
    },
    watchlistMax: cfg.watchlistMax,
    maxConcurrentOpens: cfg.maxConcurrentOpens,
  });

  console.log(
    `[pumpswap-combo] AUTONOMOUS leg=$${cfg.legUsd} solUsd=$${getSolUsd().toFixed(2)} portfolioSL=$${cfg.portfolioStopLossUsd} poll=${cfg.pollIntervalMs}ms`,
  );

  for (;;) {
    const nowMs = Date.now();
    try {
      await ensureComboSolUsd();
      const watchlist = await fetchComboWatchlist(cfg);
      rolling.prune(new Set(watchlist.map((w) => w.mint)));

      await evaluateExits(cfg);
      const scan = await evaluateEntries(cfg, watchlist, rolling, nowMs);

      if (nowMs - lastHeartbeat >= cfg.heartbeatIntervalMs) {
        lastHeartbeat = nowMs;
        const state = readComboState(cfg);
        const snap = await portfolioSnapshot(cfg, state);
        appendComboEvent(cfg, {
          kind: 'heartbeat',
          openCount: snap.openCount,
          watchlistSize: watchlist.length,
          dumpBandCount: scan.dumpBandCount,
          probeReadyCount: scan.probeReadyCount,
          realizedPnlUsd: snap.realizedPnlUsd,
          unrealizedPnlUsd: snap.unrealizedPnlUsd,
          totalPnlUsd: snap.totalPnlUsd,
          halted: snap.halted,
          solUsd: getSolUsd(),
        });
        console.log(
          `[pumpswap-combo] heartbeat open=${snap.openCount} wl=${watchlist.length} dump=${scan.dumpBandCount} probe=${scan.probeReadyCount} pnl=$${snap.totalPnlUsd.toFixed(2)} halted=${snap.halted}`,
        );
      }
    } catch (err) {
      console.warn('[pumpswap-combo] tick error', (err as Error).message);
      appendComboEvent(cfg, { kind: 'tick_error', error: (err as Error).message });
    }
    await sleep(cfg.pollIntervalMs);
  }
}

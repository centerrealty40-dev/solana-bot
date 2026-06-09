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
import { pnlPctVsAvgFill, quoteExitPriceUsdCached, quoteExitPriceUsdFresh, slPctForPosition } from './pricing.js';
import { comboLiveBridge } from './live-bridge.js';
import { configureLiveStore } from '../live/store-jsonl.js';
import { ensureComboSolUsd } from './sol-oracle.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { ComboExitMarkCache } from './exit-marks.js';
import { ensureComboWalletBalances } from './wallet-balances.js';
import { installComboRpcHooks } from './metered-rpc.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function evaluateExits(
  cfg: PumpswapComboConfig,
  balances: Map<string, bigint> | null,
  exitMarks: ComboExitMarkCache,
): Promise<void> {
  await ensureComboSolUsd();
  const state = readComboState(cfg);
  const liveCfg = comboLiveBridge(cfg);
  const closedMints = new Set<string>();

  for (const pos of state.positions) {
    if (closedMints.has(pos.mint)) continue;
    const q = await quoteExitPriceUsdCached(cfg, liveCfg, pos, balances, exitMarks);
    if (q.priceUsd == null) continue;

    updateBotPeak(pos, q.priceUsd);
    const pnlPct = pnlPctVsAvgFill(pos, q.priceUsd);
    const inv = investedUsd(pos);
    const slPct = slPctForPosition(cfg, pos);

    let action: 'tp1_partial' | 'tp2_full' | 'stop_loss' | null = null;
    if (pnlPct <= -slPct) action = 'stop_loss';
    else if (!pos.tp1Taken && pnlPct >= cfg.tp1Pct) action = 'tp1_partial';
    else if (pos.tp1Taken && pnlPct >= cfg.tp2Pct) action = 'tp2_full';
    if (!action) continue;

    const fresh = await quoteExitPriceUsdFresh(cfg, liveCfg, pos, balances, exitMarks);
    const markPriceUsd = fresh.priceUsd ?? q.priceUsd;
    const pnlAtMark = pnlPctVsAvgFill(pos, markPriceUsd);

    const res = await executeComboSell({
      cfg,
      mint: pos.mint,
      symbol: pos.symbol,
      poolAddress: pos.poolAddress,
      markPriceUsd,
      investedUsd: inv,
      pnlPctAtMark: pnlAtMark,
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
    exitMarks.invalidate(pos.mint);
    const realized = res.pnlUsd ?? inv * (pnlAtMark / 100);
    recordRealizedPnl(state, realized);
    if (realized < 0) {
      setLossCooldown(cfg, state, pos.mint, Date.now());
      void alertComboTradeLoss(cfg, { mint: pos.mint, symbol: pos.symbol, pnlUsd: realized, exitReason: action });
    }
    appendComboEvent(cfg, {
      kind: 'round_trip',
      mint: pos.mint,
      symbol: pos.symbol,
      legs: pos.legs.length,
      investedUsd: inv,
      pnlUsd: realized,
      pnlPct: pnlAtMark,
      exitReason: action,
      holdSec: Math.round((Date.now() - pos.openedAt) / 1000),
    });
  }

  if (closedMints.size) {
    state.positions = state.positions.filter((p) => !closedMints.has(p.mint));
    exitMarks.prune(closedMints);
  }
  writeComboState(cfg, state);
}

async function evaluateEntries(
  cfg: PumpswapComboConfig,
  watchlist: Awaited<ReturnType<typeof fetchComboWatchlist>>,
  rolling: RollingHighTracker,
  nowMs: number,
  balances: Map<string, bigint> | null,
  exitMarks: ComboExitMarkCache,
): Promise<{ dumpBandCount: number; probeReadyCount: number; slotsFree: number }> {
  const state = readComboState(cfg);
  pruneCooldowns(state, nowMs);
  let dumpBandCount = 0;
  let probeReadyCount = 0;

  const snap = await portfolioSnapshot(cfg, state, balances, exitMarks);
  if (applyPortfolioHalt(cfg, state, snap.totalPnlUsd)) {
    appendComboEvent(cfg, { kind: 'portfolio_halt', totalPnlUsd: snap.totalPnlUsd, limitUsd: cfg.portfolioStopLossUsd });
    writeComboState(cfg, state);
    return { dumpBandCount, probeReadyCount, slotsFree: 0 };
  }
  if (state.halted) return { dumpBandCount, probeReadyCount, slotsFree: 0 };

  const slotsFree = Math.max(0, cfg.maxConcurrentOpens - state.positions.length);

  for (const row of watchlist) {
    rolling.push(row.mint, nowMs, row.priceUsd);
    const rollHi = rolling.high15m(row.mint);
    const refHigh = Math.max(row.high15mUsd, rollHi ?? 0, row.priceUsd);
    const currentDumpPct =
      refHigh > 0 && row.priceUsd > 0 ? ((refHigh - row.priceUsd) / refHigh) * 100 : null;
    if (currentDumpPct == null) continue;

    const pos = findPosition(state, row.mint);
    if (!pos) {
      if (state.positions.length >= cfg.maxConcurrentOpens) continue;
      if (!row.pairAddress) continue;
      if (isLossCooldownActive(state, row.mint, nowMs)) continue;
      if (!inBand(currentDumpPct, cfg.dumpMinPct, cfg.dumpMaxPct)) continue;

      const streamFresh =
        row.snapshotSource === 'pumpswap-combo-stream' && nowMs - row.snapshotTs < cfg.watchlistStreamFreshMs;
      if (!row.livePriceTs && !streamFresh) {
        const signalFreshTs = row.low15mTs ?? row.snapshotTs;
        if (signalFreshTs > 0 && nowMs - signalFreshTs > cfg.dumpFreshnessMs) continue;
      }

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
        legs: [{ ts: nowMs, usd: buy.usdAtMarket ?? cfg.legUsd, fillPriceUsd: buy.fillPriceUsd, txSignature: buy.txSignature }],
        botPeakUsd: Math.max(row.priceUsd, buy.fillPriceUsd),
        tp1Taken: false,
      });
      writeComboState(cfg, state);
      continue;
    }

    if (pos.legs.length >= cfg.maxBuyLegs) continue;
    if (nowMs - (pos.legs.at(-1)?.ts ?? 0) < cfg.addMinGapMs) continue;
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
    pos.legs.push({ ts: nowMs, usd: buy.usdAtMarket ?? cfg.legUsd, fillPriceUsd: buy.fillPriceUsd, txSignature: buy.txSignature });
    writeComboState(cfg, state);
  }
  return { dumpBandCount, probeReadyCount, slotsFree };
}

export async function runPumpswapComboLoop(cfg: PumpswapComboConfig): Promise<void> {
  configureLiveStore({ storePath: cfg.journalPath, strategyId: cfg.strategyId });
  installComboRpcHooks(cfg);
  const rolling = new RollingHighTracker(cfg.rollingHighWindowMs);
  const exitMarks = new ComboExitMarkCache();
  const liveCfg = comboLiveBridge(cfg);
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
    filters: { liq: cfg.minLiquidityUsd, vol5m: cfg.minVolume5mUsd, mcap: `${cfg.minMarketCapUsd}-${cfg.maxMarketCapUsd}` },
    watchlistMax: cfg.watchlistMax,
    watchlistPgLookbackMin: cfg.watchlistPgLookbackMin,
    watchlistRpcRefresh: cfg.watchlistRpcRefreshEnabled,
    watchlistStreamPreferPg: cfg.watchlistStreamPreferPg,
    exitQuotesPerTick: cfg.exitQuotesPerTick,
    rpcMinGapMs: cfg.rpcMinGapMs,
    maxConcurrentOpens: cfg.maxConcurrentOpens,
  });

  console.log(
    `[pumpswap-combo] AUTONOMOUS leg=$${cfg.legUsd} solUsd=$${getSolUsd().toFixed(2)} portfolioSL=$${cfg.portfolioStopLossUsd} poll=${cfg.pollIntervalMs}ms exitQ/tick=${cfg.exitQuotesPerTick}`,
  );

  for (;;) {
    const nowMs = Date.now();
    try {
      await ensureComboSolUsd();
      const balances = await ensureComboWalletBalances(cfg, liveCfg);
      const state = readComboState(cfg);
      await exitMarks.refreshDue(cfg, liveCfg, state.positions, balances, nowMs);

      const watchlist = await fetchComboWatchlist(cfg);
      rolling.prune(new Set(watchlist.map((w) => w.mint)));

      await evaluateExits(cfg, balances, exitMarks);
      const scan = await evaluateEntries(cfg, watchlist, rolling, nowMs, balances, exitMarks);

      if (nowMs - lastHeartbeat >= cfg.heartbeatIntervalMs) {
        lastHeartbeat = nowMs;
        const st = readComboState(cfg);
        const snap = await portfolioSnapshot(cfg, st, balances, exitMarks);
        appendComboEvent(cfg, {
          kind: 'heartbeat',
          openCount: snap.openCount,
          watchlistSize: watchlist.length,
          dumpBandCount: scan.dumpBandCount,
          probeReadyCount: scan.probeReadyCount,
          slotsFree: scan.slotsFree,
          realizedPnlUsd: snap.realizedPnlUsd,
          unrealizedPnlUsd: snap.unrealizedPnlUsd,
          totalPnlUsd: snap.totalPnlUsd,
          halted: snap.halted,
          solUsd: getSolUsd(),
        });
        console.log(
          `[pumpswap-combo] heartbeat open=${snap.openCount} wl=${watchlist.length} dump=${scan.dumpBandCount} probe=${scan.probeReadyCount} slots=${scan.slotsFree} pnl=$${snap.totalPnlUsd.toFixed(2)} halted=${snap.halted}`,
        );
      }
    } catch (err) {
      console.warn('[pumpswap-combo] tick error', (err as Error).message);
      appendComboEvent(cfg, { kind: 'tick_error', error: (err as Error).message });
    }
    await sleep(cfg.pollIntervalMs);
  }
}

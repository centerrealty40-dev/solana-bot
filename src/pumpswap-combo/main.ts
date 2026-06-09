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
  findPosition,
  investedUsd,
  isLossCooldownActive,
  pruneCooldowns,
  readComboState,
  setLossCooldown,
  writeComboState,
} from './state.js';
import { fetchComboWatchlist } from './watchlist.js';
import { fetchShadowBuyEvents, fetchShadowBuyMints, shadowMintSet } from './shadow-wallet.js';
import { pnlPctVsAvgFill, quoteExitPriceUsd, slPctForPosition } from './pricing.js';
import { comboLiveBridge } from './live-bridge.js';
import { configureLiveStore } from '../live/store-jsonl.js';
import { ensureComboSolUsd } from './sol-oracle.js';
import { getSolUsd } from '../papertrader/pricing.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shadowMirroredSet(pos: { shadowMirroredLeaderSigs?: string[] }): Set<string> {
  return new Set(pos.shadowMirroredLeaderSigs ?? []);
}

function markShadowMirrored(
  pos: { shadowMirroredLeaderSigs?: string[] },
  leaderSignature: string,
): void {
  if (!pos.shadowMirroredLeaderSigs) pos.shadowMirroredLeaderSigs = [];
  if (!pos.shadowMirroredLeaderSigs.includes(leaderSignature)) {
    pos.shadowMirroredLeaderSigs.push(leaderSignature);
  }
}

/** Mirror hnu5 DCA buys on open positions — before SL/TP so adds can land in the same tick. */
async function evaluateShadowLeaderAdds(cfg: PumpswapComboConfig, nowMs: number): Promise<void> {
  if (!cfg.shadowWalletEnabled || !cfg.shadowAddEnabled) return;

  const state = readComboState(cfg);
  if (!state.positions.length) return;

  const events = await fetchShadowBuyEvents(cfg, getSolUsd());
  if (!events.length) return;

  let changed = false;
  for (const pos of state.positions) {
    if (pos.legs.length >= cfg.maxBuyLegs) continue;

    const mirrored = shadowMirroredSet(pos);
    const pending = events
      .filter(
        (e) =>
          e.mint === pos.mint &&
          !mirrored.has(e.signature) &&
          e.boughtAtMs >= pos.openedAt - 5000,
      )
      .sort((a, b) => a.boughtAtMs - b.boughtAtMs);

    for (const leaderBuy of pending) {
      if (pos.legs.length >= cfg.maxBuyLegs) break;

      const pool = pos.poolAddress?.trim();
      if (!pool) continue;

      const signalPrice =
        leaderBuy.fillPriceUsd > 0
          ? leaderBuy.fillPriceUsd
          : await rowPriceFallback(cfg, pos.mint);
      if (!(signalPrice > 0)) continue;

      const buy = await executeComboBuy({
        cfg,
        mint: pos.mint,
        symbol: pos.symbol,
        poolAddress: pool,
        signalPriceUsd: signalPrice,
        intent: 'shadow_add',
        dipFromPeakPct: dipFromPosPeakPct(pos, signalPrice) ?? 0,
      });
      if (!buy.ok || !(buy.fillPriceUsd && buy.fillPriceUsd > 0)) continue;

      markShadowMirrored(pos, leaderBuy.signature);
      pos.legs.push({
        ts: nowMs,
        usd: buy.usdAtMarket ?? cfg.legUsd,
        fillPriceUsd: buy.fillPriceUsd,
        txSignature: buy.txSignature,
      });
      updateBotPeak(pos, Math.max(signalPrice, buy.fillPriceUsd));
      changed = true;

      appendComboEvent(cfg, {
        kind: 'shadow_add',
        mint: pos.mint,
        symbol: pos.symbol,
        leaderSignature: leaderBuy.signature,
        leaderPriceUsd: leaderBuy.fillPriceUsd,
        leaderBuyUsd: leaderBuy.usdEst,
        fillPriceUsd: buy.fillPriceUsd,
        leg: pos.legs.length,
      });
    }
  }

  if (changed) writeComboState(cfg, state);
}

async function rowPriceFallback(cfg: PumpswapComboConfig, mint: string): Promise<number> {
  const wl = await fetchComboWatchlist(cfg);
  return wl.find((r) => r.mint === mint)?.priceUsd ?? 0;
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
): Promise<{ dumpBandCount: number; probeReadyCount: number; shadowMintCount: number }> {
  const state = readComboState(cfg);
  pruneCooldowns(state, nowMs);
  let dumpBandCount = 0;
  let probeReadyCount = 0;
  const shadowBuys = cfg.shadowWalletEnabled ? await fetchShadowBuyMints(cfg, getSolUsd()) : [];
  const shadowByMint = new Map(shadowBuys.map((s) => [s.mint, s]));
  const activeShadow = shadowMintSet(shadowBuys);
  const shadowMintCount = activeShadow.size;

  const snap = await portfolioSnapshot(cfg, state);
  if (applyPortfolioHalt(cfg, state, snap.totalPnlUsd)) {
    appendComboEvent(cfg, {
      kind: 'portfolio_halt',
      totalPnlUsd: snap.totalPnlUsd,
      limitUsd: cfg.portfolioStopLossUsd,
    });
    writeComboState(cfg, state);
    return { dumpBandCount, probeReadyCount, shadowMintCount };
  }

  if (state.halted) return { dumpBandCount, probeReadyCount, shadowMintCount };

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

      const shadowCoTrade =
        cfg.shadowEntryEnabled && (row.fromShadow || activeShadow.has(row.mint));

      if (!shadowCoTrade) {
        if (!inBand(currentDumpPct, cfg.dumpMinPct, cfg.dumpMaxPct)) continue;
        if (row.low15mTs > 0 && nowMs - row.low15mTs > cfg.dumpFreshnessMs) continue;
      } else {
        const leaderBuy = shadowByMint.get(row.mint);
        if (!leaderBuy || nowMs - leaderBuy.boughtAtMs > cfg.shadowEntryMaxAgeMs) continue;
      }
      dumpBandCount++;

      if (shadowCoTrade) {
        const leaderBuy = shadowByMint.get(row.mint)!;
        const entryPx = leaderBuy.fillPriceUsd > 0 ? leaderBuy.fillPriceUsd : row.priceUsd;
        if (!(entryPx > 0)) continue;
      } else {
        const dipPeak = rolling.dipFromBotPeakPct(row.mint, row.priceUsd);
        if (dipPeak == null || dipPeak > cfg.probeMaxDipFromPeakPct) continue;
      }
      probeReadyCount++;

      const dipPeak = shadowCoTrade
        ? 0
        : (rolling.dipFromBotPeakPct(row.mint, row.priceUsd) ?? 0);

      const leaderBuy = shadowCoTrade ? shadowByMint.get(row.mint) : undefined;
      const signalPx =
        shadowCoTrade && leaderBuy && leaderBuy.fillPriceUsd > 0
          ? leaderBuy.fillPriceUsd
          : row.priceUsd;

      const buy = await executeComboBuy({
        cfg,
        mint: row.mint,
        symbol: row.symbol,
        poolAddress: row.pairAddress,
        signalPriceUsd: signalPx,
        intent: shadowCoTrade ? 'shadow_probe' : 'probe',
        dumpPct: currentDumpPct,
        dipFromPeakPct: dipPeak,
      });
      if (!buy.ok || !(buy.fillPriceUsd && buy.fillPriceUsd > 0)) continue;

      const opened: typeof state.positions[0] = {
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
        botPeakUsd: Math.max(signalPx, buy.fillPriceUsd),
        tp1Taken: false,
      };
      if (shadowCoTrade && leaderBuy) {
        markShadowMirrored(opened, leaderBuy.signature);
      }
      state.positions.push(opened);
      writeComboState(cfg, state);
      continue;
    }

    if (pos.legs.length >= cfg.maxBuyLegs) continue;
    const lastLegTs = pos.legs.at(-1)?.ts ?? 0;
    if (nowMs - lastLegTs < cfg.addMinGapMs) continue;

    updateBotPeak(pos, row.priceUsd);
    const dip = dipFromPosPeakPct(pos, row.priceUsd);
    if (dip == null || !inBand(dip, cfg.addDipMinPct, cfg.addDipMaxPct)) continue;

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
  return { dumpBandCount, probeReadyCount, shadowMintCount };
}

export async function runPumpswapComboLoop(cfg: PumpswapComboConfig): Promise<void> {
  configureLiveStore({ storePath: cfg.journalPath, strategyId: cfg.strategyId });
  const rolling = new RollingHighTracker(cfg.rollingHighWindowMs);
  let lastHeartbeat = 0;

  const solUsdBoot = await ensureComboSolUsd(true);

  appendComboEvent(cfg, {
    kind: 'boot',
    execVenue: 'pumpswap_direct',
    legUsd: cfg.legUsd,
    solUsd: solUsdBoot,
    portfolioStopLossUsd: cfg.portfolioStopLossUsd,
    dumpBand: `${cfg.dumpMinPct}-${cfg.dumpMaxPct}`,
    tp1: `${cfg.tp1SellFrac * 100}%@${cfg.tp1Pct}%`,
    tp2: `@${cfg.tp2Pct}%`,
    slSingle: cfg.slSingleLegPct,
    slMulti: cfg.slMultiLegPct,
    slPreDca: cfg.slPreDcaPct,
    addMinGapMs: cfg.addMinGapMs,
    shadowAdd: cfg.shadowAddEnabled,
    shadowEntryMaxAgeMs: cfg.shadowEntryMaxAgeMs,
    filters: {
      liq: cfg.minLiquidityUsd,
      vol5m: cfg.minVolume5mUsd,
      mcap: `${cfg.minMarketCapUsd}-${cfg.maxMarketCapUsd}`,
    },
    watchlistMax: cfg.watchlistMax,
    maxConcurrentOpens: cfg.maxConcurrentOpens,
    shadowWallet: cfg.shadowWalletEnabled ? cfg.shadowWalletPubkey : null,
  });

  console.log(
    `[pumpswap-combo] LIVE leg=$${cfg.legUsd} solUsd=$${getSolUsd().toFixed(2)} portfolioSL=$${cfg.portfolioStopLossUsd} poll=${cfg.pollIntervalMs}ms`,
  );

  for (;;) {
    const nowMs = Date.now();
    try {
      await ensureComboSolUsd();
      const watchlist = await fetchComboWatchlist(cfg);
      rolling.prune(new Set(watchlist.map((w) => w.mint)));

      await evaluateShadowLeaderAdds(cfg, nowMs);
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
          shadowMintCount: scan.shadowMintCount,
          realizedPnlUsd: snap.realizedPnlUsd,
          unrealizedPnlUsd: snap.unrealizedPnlUsd,
          totalPnlUsd: snap.totalPnlUsd,
          halted: snap.halted,
          solUsd: getSolUsd(),
        });
        console.log(
          `[pumpswap-combo] heartbeat open=${snap.openCount} wl=${watchlist.length} shadow=${scan.shadowMintCount} dump=${scan.dumpBandCount} probe=${scan.probeReadyCount} pnl=$${snap.totalPnlUsd.toFixed(2)} halted=${snap.halted}`,
        );
      }
    } catch (err) {
      console.warn('[pumpswap-combo] tick error', (err as Error).message);
      appendComboEvent(cfg, { kind: 'tick_error', error: (err as Error).message });
    }
    await sleep(cfg.pollIntervalMs);
  }
}

import type { PaperTraderConfig, DcaLevel, TpLadderLevel } from '../config.js';
import type { ClosedTrade, ExitReason, OpenTrade, PartialSell, PositionLeg } from '../types.js';
import { fetchLatestSnapshotPrice, getLiveMcUsd } from '../pricing.js';
import { applyEntryCosts, applyExitCosts, buildCloseCosts } from '../costs.js';
import { appendEvent } from '../store-jsonl.js';
import { fetchContextSwaps } from './context-swaps.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TrackerStats {
  closed: Record<ExitReason, number>;
}

export interface TrackerArgs {
  cfg: PaperTraderConfig;
  open: Map<string, OpenTrade>;
  closed: ClosedTrade[];
  dcaLevels: DcaLevel[];
  tpLadder: TpLadderLevel[];
  stats: TrackerStats;
  btcCtx: () => { ret1h_pct: number | null; ret4h_pct: number | null; updated_ts: number | null };
}

interface PeakState {
  lastPersistedPeak: number;
}
const peakStateByMint = new Map<string, PeakState>();

function totalProceedsNet(ot: OpenTrade): number {
  return ot.partialSells.reduce((s, p) => s + (p.proceedsUsd || 0), 0);
}
function totalProceedsGross(ot: OpenTrade): number {
  return ot.partialSells.reduce((s, p) => s + (p.grossProceedsUsd || 0), 0);
}

function buildClosedTrade(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  marketSell: number;
  effectiveSell: number;
  exitReason: ExitReason;
  ageH: number;
}): ClosedTrade {
  const { cfg, ot, marketSell, effectiveSell, exitReason, ageH } = args;
  let finalProceeds = 0;
  let finalGrossProceeds = 0;
  if (ot.remainingFraction > 1e-6 && marketSell > 0) {
    finalProceeds = ot.totalInvestedUsd * ot.remainingFraction * (effectiveSell / ot.avgEntry);
    finalGrossProceeds = ot.totalInvestedUsd * ot.remainingFraction * (marketSell / ot.avgEntryMarket);
  }
  const totalProceedsUsd = totalProceedsNet(ot) + finalProceeds;
  const grossTotalProceedsUsd = totalProceedsGross(ot) + finalGrossProceeds;
  const netPnlUsd = totalProceedsUsd - ot.totalInvestedUsd;
  const grossPnlUsd = grossTotalProceedsUsd - ot.totalInvestedUsd;
  const totalPnlPct = ot.totalInvestedUsd > 0 ? (netPnlUsd / ot.totalInvestedUsd) * 100 : 0;
  const grossPnlPct = ot.totalInvestedUsd > 0 ? (grossPnlUsd / ot.totalInvestedUsd) * 100 : 0;

  const networkFeeUsdTotal = (ot.legs.length + ot.partialSells.length + 1) * cfg.networkFeeUsd;

  const slipDynamicBpsEntry = 0;
  const slipDynamicBpsExit = 0;

  const costs = buildCloseCosts({
    cfg,
    trade: ot,
    exit: { effectivePrice: effectiveSell, marketPrice: marketSell },
    networkFeeUsdTotal,
    slipDynamicBpsEntry,
    slipDynamicBpsExit,
    netPnlUsd,
    grossPnlUsd,
  });

  const firstLeg: PositionLeg | undefined = ot.legs[0];
  return {
    ...ot,
    exitTs: Date.now(),
    exitMcUsd: marketSell,
    exitReason,
    pnlPct: totalPnlPct,
    durationMin: ageH * 60,
    totalProceedsUsd,
    netPnlUsd,
    grossTotalProceedsUsd,
    grossPnlUsd,
    grossPnlPct,
    costs,
    effective_entry_price: ot.avgEntry,
    effective_exit_price: effectiveSell,
    theoretical_entry_price: firstLeg ? firstLeg.marketPrice : ot.avgEntryMarket,
    theoretical_exit_price: marketSell,
  };
}

export async function trackerTick(args: TrackerArgs): Promise<void> {
  const { cfg, open, closed, dcaLevels, tpLadder, stats, btcCtx } = args;
  if (open.size === 0) return;
  const mints = [...open.keys()];

  for (const mint of mints) {
    const ot = open.get(mint);
    if (!ot) continue;

    let curMetric = 0;
    try {
      curMetric = Number(
        await fetchLatestSnapshotPrice(
          mint,
          ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | undefined,
        ) ?? 0,
      );
    } catch (err) {
      console.warn(`tracker fetch failed for ${mint}: ${(err as Error).message}`);
    }
    await sleep(120);

    const ageH = (Date.now() - ot.entryTs) / 3_600_000;

    if (!(curMetric > 0)) {
      if (ageH > cfg.timeoutHours) {
        const ct = buildClosedTrade({
          cfg,
          ot,
          marketSell: 0,
          effectiveSell: 0,
          exitReason: 'NO_DATA',
          ageH,
        });
        open.delete(mint);
        closed.push(ct);
        stats.closed.NO_DATA++;
        const exitSwaps = await fetchContextSwaps(cfg, mint, Date.now());
        const mcUsdLive_closeNd = await getLiveMcUsd(
          mint,
          ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | undefined,
        );
        appendEvent({
          kind: 'close',
          ...ct,
          peak_pnl_pct: +ot.peakPnlPct.toFixed(2),
          btc_exit: btcCtx(),
          exit_swaps: exitSwaps,
          mcUsdLive: mcUsdLive_closeNd,
        });
        peakStateByMint.delete(mint);
        console.log(`[NO_DATA] ${mint.slice(0, 8)} $${ot.symbol}`);
      }
      continue;
    }

    const firstPrice = ot.legs[0]?.price || ot.entryMcUsd;
    const dropFromFirstPct = curMetric / firstPrice - 1;
    const xAvg = curMetric / ot.avgEntry;
    const pnlPctVsAvg = (xAvg - 1) * 100;

    if (curMetric > ot.peakMcUsd) {
      const wasArmed = ot.trailingArmed;
      ot.peakMcUsd = curMetric;
      ot.peakPnlPct = pnlPctVsAvg;
      if (xAvg >= cfg.trailTriggerX) ot.trailingArmed = true;
      const ps = peakStateByMint.get(mint) || { lastPersistedPeak: -Infinity };
      if ((!wasArmed && ot.trailingArmed) || pnlPctVsAvg >= ps.lastPersistedPeak + cfg.peakLogStepPct) {
        ps.lastPersistedPeak = pnlPctVsAvg;
        peakStateByMint.set(mint, ps);
        appendEvent({
          kind: 'peak',
          mint,
          peakMcUsd: ot.peakMcUsd,
          peakPnlPct: ot.peakPnlPct,
          trailingArmed: ot.trailingArmed,
        });
      }
    }

    if ((dcaLevels.length > 0 || cfg.dcaKillstop < 0) && ot.remainingFraction > 0) {
      for (const lvl of dcaLevels) {
        if (ot.dcaUsedLevels.has(lvl.triggerPct)) continue;
        if (dropFromFirstPct <= lvl.triggerPct) {
          const addUsd = cfg.positionUsd * lvl.addFraction;
          const marketBuy = curMetric;
          const { effectivePrice: effectiveBuy } = applyEntryCosts(cfg, marketBuy, ot.dex, addUsd, null);
          ot.legs.push({
            ts: Date.now(),
            price: effectiveBuy,
            marketPrice: marketBuy,
            sizeUsd: addUsd,
            reason: 'dca',
            triggerPct: lvl.triggerPct,
          });
          ot.totalInvestedUsd += addUsd;
          const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
          ot.avgEntry = num / ot.totalInvestedUsd;
          const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
          ot.avgEntryMarket = numM / ot.totalInvestedUsd;
          ot.dcaUsedLevels.add(lvl.triggerPct);
          ot.remainingFraction = 1;
          if (curMetric > ot.peakMcUsd) ot.peakMcUsd = curMetric;
          ot.peakPnlPct = (curMetric / ot.avgEntry - 1) * 100;
          ot.trailingArmed = ot.trailingArmed && curMetric / ot.avgEntry >= cfg.trailTriggerX;
          const mcUsdLive_dca = await getLiveMcUsd(
            mint,
            ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | undefined,
          );
          appendEvent({
            kind: 'dca_add',
            mint,
            ts: Date.now(),
            price: effectiveBuy,
            marketPrice: marketBuy,
            sizeUsd: addUsd,
            triggerPct: lvl.triggerPct,
            avgEntry: ot.avgEntry,
            avgEntryMarket: ot.avgEntryMarket,
            totalInvestedUsd: ot.totalInvestedUsd,
            legCount: ot.legs.length,
            mcUsdLive: mcUsdLive_dca,
          });
          console.log(
            `[DCA] ${mint.slice(0, 8)} $${ot.symbol} +$${addUsd.toFixed(0)} @trigger=${(lvl.triggerPct * 100).toFixed(0)}% avgEff=${ot.avgEntry.toFixed(8)}`,
          );
        }
      }
    }

    if (tpLadder.length > 0 && ot.remainingFraction > 0) {
      for (const lvl of tpLadder) {
        if (ot.ladderUsedLevels.has(lvl.pnlPct)) continue;
        if (xAvg - 1 >= lvl.pnlPct) {
          const sellFraction = Math.min(1, lvl.sellFraction);
          const marketSell = curMetric;
          const investedSoldUsd = ot.totalInvestedUsd * ot.remainingFraction * sellFraction;
          const { effectivePrice: effectiveSell } = applyExitCosts(
            cfg,
            marketSell,
            ot.dex,
            investedSoldUsd,
            null,
          );
          const remainingValueNet = ot.totalInvestedUsd * ot.remainingFraction * (effectiveSell / ot.avgEntry);
          const proceedsUsd = remainingValueNet * sellFraction;
          const remainingValueGross =
            ot.totalInvestedUsd * ot.remainingFraction * (marketSell / ot.avgEntryMarket);
          const grossProceedsUsd = remainingValueGross * sellFraction;
          const pnlUsd = proceedsUsd - investedSoldUsd;
          const grossPnlUsd = grossProceedsUsd - investedSoldUsd;

          const ps: PartialSell = {
            ts: Date.now(),
            price: effectiveSell,
            marketPrice: marketSell,
            sellFraction,
            reason: 'TP_LADDER',
            proceedsUsd,
            grossProceedsUsd,
            pnlUsd,
            grossPnlUsd,
          };
          ot.partialSells.push(ps);
          ot.remainingFraction *= 1 - sellFraction;
          ot.ladderUsedLevels.add(lvl.pnlPct);
          const mcUsdLive_ps = await getLiveMcUsd(
            mint,
            ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | undefined,
          );
          appendEvent({
            kind: 'partial_sell',
            mint,
            ts: ps.ts,
            price: effectiveSell,
            marketPrice: marketSell,
            sellFraction,
            ladderPnlPct: lvl.pnlPct,
            reason: 'TP_LADDER',
            proceedsUsd,
            grossProceedsUsd,
            pnlUsd,
            grossPnlUsd,
            remainingFraction: ot.remainingFraction,
            mcUsdLive: mcUsdLive_ps,
          });
          console.log(
            `[TP${(lvl.pnlPct * 100).toFixed(0)}] ${mint.slice(0, 8)} $${ot.symbol} sold=${(sellFraction * 100).toFixed(0)}% pnl=$${pnlUsd.toFixed(2)} remain=${(ot.remainingFraction * 100).toFixed(0)}%`,
          );
        }
      }
    }

    let exitReason: ExitReason | null = null;
    if (cfg.dcaKillstop < 0 && pnlPctVsAvg / 100 <= cfg.dcaKillstop) exitReason = 'KILLSTOP';
    else if (xAvg >= cfg.tpX) exitReason = 'TP';
    else if (cfg.slX > 0 && xAvg <= cfg.slX) exitReason = 'SL';
    else if (ot.trailingArmed && curMetric <= ot.peakMcUsd * (1 - cfg.trailDrop)) exitReason = 'TRAIL';
    else if (ageH >= cfg.timeoutHours) exitReason = 'TIMEOUT';
    if (!exitReason && ot.remainingFraction <= 1e-6) exitReason = 'TP';

    if (exitReason) {
      const marketSell = curMetric;
      const investedRemaining = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
      const { effectivePrice: effectiveSell } = applyExitCosts(
        cfg,
        marketSell,
        ot.dex,
        Math.max(1, investedRemaining),
        null,
      );
      const exitSwaps = await fetchContextSwaps(cfg, mint, Date.now());
      const ct = buildClosedTrade({ cfg, ot, marketSell, effectiveSell, exitReason, ageH });
      open.delete(mint);
      closed.push(ct);
      const statKey: ExitReason = exitReason === 'KILLSTOP' ? 'SL' : exitReason;
      if (stats.closed[statKey] != null) stats.closed[statKey]++;
      const mcUsdLive_close = await getLiveMcUsd(
        mint,
        ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | undefined,
      );
      appendEvent({
        kind: 'close',
        ...ct,
        peak_pnl_pct: +ot.peakPnlPct.toFixed(2),
        btc_exit: btcCtx(),
        exit_market_price: marketSell,
        exit_effective_price: effectiveSell,
        exit_swaps: exitSwaps,
        mcUsdLive: mcUsdLive_close,
      });
      peakStateByMint.delete(mint);
      const arrow = ct.pnlPct >= 0 ? '+' : '';
      console.log(
        `[${exitReason}] ${mint.slice(0, 8)} $${ot.symbol} pnl_net=${arrow}${ct.pnlPct.toFixed(1)}%/$${ct.netPnlUsd.toFixed(2)} legs=${ot.legs.length} sells=${ot.partialSells.length} age=${ageH.toFixed(1)}h`,
      );
    }
  }
}

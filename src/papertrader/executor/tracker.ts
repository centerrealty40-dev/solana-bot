import type { PaperTraderConfig, DcaLevel, TpLadderLevel } from '../config.js';
import type {
  ClosedTrade,
  DexSource,
  ExitContext,
  ExitReason,
  OpenTrade,
  PartialSell,
  PositionLeg,
  PriceVerifyVerdict,
} from '../types.js';
import { fetchLatestSnapshotPrice, getLiveMcUsd, getSolUsd } from '../pricing.js';
import { verifyExitPrice } from '../pricing/price-verify.js';
import { getPriorityFeeUsd } from '../pricing/priority-fee.js';
import {
  buildOptionalLiqWatchCloseStamp,
  evaluateLiqDrainState,
  loadCurrentPoolLiqUsd,
} from '../pricing/liq-watch.js';
import { applyEntryCosts, applyExitCosts, buildCloseCosts } from '../costs.js';
import type { LiveOscarPhase4Tracker } from '../../live/phase4-types.js';
import { fetchContextSwaps } from './context-swaps.js';
import {
  collectFiredLadderPnls,
  ladderRetraceTriggered,
  ladderStepOrThresholdTaken,
  markLadderStepFired,
} from './tp-ladder-state.js';
import { dcaCrossedDownward, dcaEffPrev, dcaStepOrTriggerTaken, markDcaStepFired } from './dca-state.js';
import { child } from '../../core/logger.js';
import { serializeClosedTrade, serializeOpenTrade } from '../../live/strategy-snapshot.js';

const log = child('tracker');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export { ladderRetraceTriggered } from './tp-ladder-state.js';

/** W7.4.2 — returns verdict for JSONL stamping; `defer` means skip this exit attempt until next tracker tick. */
async function exitPriceVerifyGate(args: {
  cfg: PaperTraderConfig;
  mint: string;
  symbol: string;
  tokenDecimals: number;
  usdNotional: number;
  snapshotPriceUsd: number;
  context: 'partial_sell' | 'close';
  journalAppend: TrackerArgs['journalAppend'];
  stats: TrackerStats;
}): Promise<{ defer: boolean; verdict: PriceVerifyVerdict | null }> {
  const {
    cfg,
    mint,
    symbol,
    tokenDecimals,
    usdNotional,
    snapshotPriceUsd,
    context,
    journalAppend,
    stats,
  } = args;
  if (!cfg.priceVerifyExitEnabled) return { defer: false, verdict: null };
  if (!(usdNotional > 1e-6) || !(snapshotPriceUsd > 0)) return { defer: false, verdict: null };

  const solUsd = getSolUsd() ?? 0;
  let verdict: PriceVerifyVerdict;
  try {
    verdict = await verifyExitPrice({
      cfg,
      mint,
      tokenDecimals,
      usdNotional,
      solUsd,
      snapshotPriceUsd,
    });
  } catch (e) {
    log.warn({ err: (e as Error)?.message, mint: mint.slice(0, 8) }, 'verifyExitPrice threw');
    verdict = { kind: 'skipped', reason: 'fetch-fail', ts: Date.now() };
  }

  if (verdict.kind === 'blocked' && cfg.priceVerifyExitBlockOnFail) {
    stats.skippedPriceVerifyExit += 1;
    journalAppend({
      kind: 'eval-skip-exit',
      mint,
      symbol,
      context,
      reason: `price_verify_exit:${verdict.reason}`,
      priceVerifyExit: verdict,
    });
    return { defer: true, verdict };
  }

  return { defer: false, verdict };
}

export interface TrackerStats {
  closed: Record<ExitReason, number>;
  /** W7.4.2 — exits deferred because pre-exit Jupiter quote failed gates with block_on_fail. */
  skippedPriceVerifyExit: number;
}

export interface TrackerArgs {
  cfg: PaperTraderConfig;
  open: Map<string, OpenTrade>;
  closed: ClosedTrade[];
  dcaLevels: DcaLevel[];
  tpLadder: TpLadderLevel[];
  stats: TrackerStats;
  btcCtx: () => { ret1h_pct: number | null; ret4h_pct: number | null; updated_ts: number | null };
  /** Paper JSONL or live noop — never mix stores (W8.0-p4 P4-I1). */
  journalAppend: (event: Record<string, unknown>) => void;
  /** W8.0 Phase 7 — live JSONL `live_position_*` mirror for replay. */
  journalLiveStrategy?: (event: Record<string, unknown>) => void;
  /** Live-oscar simulate sells / DCA buys after tracker decisions. */
  livePhase4?: LiveOscarPhase4Tracker;
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

/**
 * Builds a self-contained, audit-ready summary of WHY this trade is closing.
 * Lets the dashboard render "TP +7.2% (peak +32%, retrace −19pp)" style strings
 * instead of just "TP".
 *
 * Pure helper — no I/O. All inputs are taken from the OpenTrade snapshot and
 * the per-strategy config that fired the close.
 */
function buildExitContext(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  closePnlPct: number;
  ageH: number;
  exitReason: ExitReason;
  curMetric: number;
  xAvg: number;
  tpLadder: TpLadderLevel[];
  liqDrop?: { dropPct: number; entryLiqUsd: number; currentLiqUsd: number; ageMs: number } | null;
}): ExitContext {
  const { cfg, ot, closePnlPct, ageH, exitReason, curMetric, xAvg, tpLadder, liqDrop } = args;
  const peak = ot.peakPnlPct;
  const retraceFromPeakPct =
    peak > 0 && Number.isFinite(peak)
      ? +(((peak - closePnlPct) / peak) * 100).toFixed(2)
      : null;
  const tpLadderHits = collectFiredLadderPnls(ot, tpLadder).length;
  const tpLadderTotal = tpLadder.length;
  const dcaLegsAdded = Math.max(0, ot.legs.length - 1);

  let triggerLabel = exitReason as string;
  switch (exitReason) {
    case 'TP': {
      if (ot.remainingFraction <= 1e-6 && tpLadderHits > 0) {
        triggerLabel = `TP ladder fully unwound (${tpLadderHits}/${tpLadderTotal} hits)`;
      } else if (xAvg >= cfg.tpX) {
        triggerLabel = `TP xAvg≥${cfg.tpX.toFixed(2)} (cur ${xAvg.toFixed(2)}x)`;
      } else {
        triggerLabel = `TP (no remaining)`;
      }
      break;
    }
    case 'SL':
      triggerLabel = `SL xAvg≤${cfg.slX.toFixed(2)} (cur ${xAvg.toFixed(2)}x)`;
      break;
    case 'TRAIL':
      if (cfg.trailMode === 'ladder_retrace') {
        triggerLabel = `TRAIL ladder retrace (${tpLadderHits}/${tpLadderTotal} hits, cur ${xAvg.toFixed(2)}x, peak ${(1 + peak / 100).toFixed(2)}x)`;
      } else {
        const peakX = ot.peakMcUsd > 0 ? curMetric / ot.peakMcUsd : 0;
        triggerLabel = `TRAIL peak retrace ${((peakX - 1) * 100).toFixed(1)}% from peak (drop≥${(cfg.trailDrop * 100).toFixed(0)}%)`;
      }
      break;
    case 'TIMEOUT':
      triggerLabel = `TIMEOUT ${cfg.timeoutHours}h${ot.trailingArmed ? ' (trail was armed)' : ' (trail NEVER armed; need ' + cfg.trailTriggerX.toFixed(2) + 'x)'}`;
      break;
    case 'KILLSTOP':
      triggerLabel = `DCA killstop ${(cfg.dcaKillstop * 100).toFixed(0)}% (cur ${closePnlPct.toFixed(1)}% vs avg, ${dcaLegsAdded} DCA legs)`;
      break;
    case 'NO_DATA':
      triggerLabel = `no-data ${cfg.timeoutHours}h (price stream gone — hard close)`;
      break;
    case 'LIQ_DRAIN':
      if (liqDrop) {
        const ageS = Math.round(liqDrop.ageMs / 1000);
        triggerLabel = `liq drop ${liqDrop.dropPct.toFixed(1)}% ($${Math.round(liqDrop.entryLiqUsd).toLocaleString()} → $${Math.round(liqDrop.currentLiqUsd).toLocaleString()}, snapshot ${ageS}s old)`;
      } else {
        triggerLabel = `liq drain (no detail)`;
      }
      break;
  }

  return {
    closePnlPct: +closePnlPct.toFixed(2),
    peakPnlPct: +peak.toFixed(2),
    retraceFromPeakPct,
    trailingArmed: ot.trailingArmed,
    ageHours: +ageH.toFixed(3),
    tpLadderHits,
    tpLadderTotal,
    dcaLegsAdded,
    remainingFractionAtClose: +ot.remainingFraction.toFixed(4),
    triggerLabel,
    cfgSnapshot: {
      tpX: cfg.tpX,
      slX: cfg.slX,
      trailMode: cfg.trailMode,
      trailDrop: cfg.trailDrop,
      trailTriggerX: cfg.trailTriggerX,
      timeoutHours: cfg.timeoutHours,
      dcaKillstop: cfg.dcaKillstop,
    },
  };
}

function buildClosedTrade(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  marketSell: number;
  effectiveSell: number;
  exitReason: ExitReason;
  ageH: number;
  /** W7.3 — per simulated tx (buy/sell legs + partials + final exit). */
  networkFeeUsdPerTx: number;
}): ClosedTrade {
  const { cfg, ot, marketSell, effectiveSell, exitReason, ageH, networkFeeUsdPerTx } = args;
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

  const networkFeeUsdTotal = (ot.legs.length + ot.partialSells.length + 1) * networkFeeUsdPerTx;

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
  const { cfg, open, closed, dcaLevels, tpLadder, stats, btcCtx, journalAppend, journalLiveStrategy, livePhase4 } =
    args;
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
          ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
        ) ?? 0,
      );
    } catch (err) {
      console.warn(`tracker fetch failed for ${mint}: ${(err as Error).message}`);
    }
    await sleep(120);

    if (curMetric > 0) {
      ot.lastObservedPriceUsd = curMetric;
    }

    const ageH = (Date.now() - ot.entryTs) / 3_600_000;

    // ----- W7.5 — liquidity drain watch (before TP/SL/TRAIL and NO_DATA stall close) -----
    if (cfg.liqWatchEnabled && ot.pairAddress && (ot.entryLiqUsd ?? 0) > 0) {
      const positionAgeMs = Math.max(0, Date.now() - ot.entryTs);
      const load = await loadCurrentPoolLiqUsd({
        pairAddress: ot.pairAddress,
        source: ot.source as DexSource,
        cfg,
      });
      const verdict = evaluateLiqDrainState({
        cfg,
        entryLiqUsd: ot.entryLiqUsd!,
        load,
        consecutiveFailures: ot.liqWatchConsecutiveFailures ?? 0,
        positionAgeMs,
      });

      if (verdict.kind === 'pending') {
        ot.liqWatchConsecutiveFailures = verdict.consecutiveFailures;
        ot.liqWatchLastLiqUsd = verdict.currentLiqUsd;
      } else if (verdict.kind === 'ok') {
        ot.liqWatchConsecutiveFailures = 0;
        ot.liqWatchLastLiqUsd = verdict.currentLiqUsd;
        ot.liqWatchLastDropPct = verdict.dropPct;
      } else if (verdict.kind === 'force-close' && cfg.liqWatchForceClose) {
        ot.liqWatchConsecutiveFailures = cfg.liqWatchConsecutiveFailures;
        const rawPx =
          ot.lastObservedPriceUsd ??
          ot.legs[0]?.marketPrice ??
          ot.avgEntryMarket ??
          ot.avgEntry ??
          0;
        const marketSell = Number(rawPx) > 0 ? Number(rawPx) : ot.avgEntry > 0 ? ot.avgEntry : 0;
        const investedRemaining = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
        const { effectivePrice: effectiveSell } = applyExitCosts(
          cfg,
          marketSell,
          ot.dex,
          Math.max(1, investedRemaining),
          null,
        );
        const exitSwaps = await fetchContextSwaps(cfg, mint, Date.now());
        const pfClose = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
        const perTxClose = pfClose.usd > 0 ? pfClose.usd : cfg.networkFeeUsd;
        const ct = buildClosedTrade({
          cfg,
          ot,
          marketSell,
          effectiveSell,
          exitReason: 'LIQ_DRAIN',
          ageH,
          networkFeeUsdPerTx: perTxClose,
        });
        const exitContext = buildExitContext({
          cfg,
          ot,
          closePnlPct: ct.pnlPct,
          ageH,
          exitReason: 'LIQ_DRAIN',
          curMetric: marketSell,
          xAvg: ot.avgEntry > 0 ? marketSell / ot.avgEntry : 1,
          tpLadder,
          liqDrop: {
            dropPct: verdict.dropPct,
            entryLiqUsd: ot.entryLiqUsd ?? 0,
            currentLiqUsd: verdict.currentLiqUsd,
            ageMs: verdict.ageMs,
          },
        });
        ct.exitContext = exitContext;
        if (livePhase4 && marketSell > 0 && investedRemaining > 1e-6) {
          const ok = await livePhase4.tryTokenToSolSell({
            mint,
            symbol: ot.symbol,
            usdNotional: investedRemaining,
            priceUsdPerToken: marketSell,
            decimals: ot.tokenDecimals ?? 6,
            intentKind: 'sell_full',
          });
          if (!ok) continue;
        }
        open.delete(mint);
        closed.push(ct);
        stats.closed.LIQ_DRAIN++;
        const mcUsdLive_close = await getLiveMcUsd(
          mint,
          ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
        );
        journalAppend({
          kind: 'close',
          ...ct,
          peak_pnl_pct: +ot.peakPnlPct.toFixed(2),
          btc_exit: btcCtx(),
          exit_market_price: marketSell,
          exit_effective_price: effectiveSell,
          exit_swaps: exitSwaps,
          mcUsdLive: mcUsdLive_close,
          priorityFee: pfClose,
          exitContext,
          liqWatch: {
            source: verdict.from,
            entryLiqUsd: ot.entryLiqUsd,
            currentLiqUsd: verdict.currentLiqUsd,
            dropPct: verdict.dropPct,
            ageMs: verdict.ageMs,
            consecutiveFailures: cfg.liqWatchConsecutiveFailures,
            ts: verdict.ts,
          },
        });
        journalLiveStrategy?.({
          kind: 'live_position_close',
          mint,
          closedTrade: serializeClosedTrade(ct),
        });
        peakStateByMint.delete(mint);
        console.log(
          `[LIQ_DRAIN] ${mint.slice(0, 8)} $${ot.symbol} drop=${verdict.dropPct.toFixed(1)}% liq=$${verdict.currentLiqUsd.toFixed(0)}`,
        );
        continue;
      } else if (verdict.kind === 'force-close' && !cfg.liqWatchForceClose) {
        log.warn(
          { mint: mint.slice(0, 8), dropPct: verdict.dropPct, currentLiqUsd: verdict.currentLiqUsd },
          'liq-watch force-close suppressed (shadow)',
        );
        ot.liqWatchLastLiqUsd = verdict.currentLiqUsd;
        ot.liqWatchLastDropPct = verdict.dropPct;
      }

      if (cfg.liqWatchStampOnTrack) {
        journalAppend({
          kind: 'liq_watch_tick',
          mint,
          verdict,
        });
      }
    }

    if (!(curMetric > 0)) {
      if (ageH > cfg.timeoutHours) {
        const pfCloseNd = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
        const perTxNd = pfCloseNd.usd > 0 ? pfCloseNd.usd : cfg.networkFeeUsd;
        const ct = buildClosedTrade({
          cfg,
          ot,
          marketSell: 0,
          effectiveSell: 0,
          exitReason: 'NO_DATA',
          ageH,
          networkFeeUsdPerTx: perTxNd,
        });
        const exitContextNd = buildExitContext({
          cfg,
          ot,
          closePnlPct: ct.pnlPct,
          ageH,
          exitReason: 'NO_DATA',
          curMetric: 0,
          xAvg: 0,
          tpLadder,
        });
        ct.exitContext = exitContextNd;
        open.delete(mint);
        closed.push(ct);
        stats.closed.NO_DATA++;
        const exitSwaps = await fetchContextSwaps(cfg, mint, Date.now());
        const mcUsdLive_closeNd = await getLiveMcUsd(
          mint,
          ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
        );
        const liqWatchNoData = await buildOptionalLiqWatchCloseStamp(cfg, ot);
        journalAppend({
          kind: 'close',
          ...ct,
          peak_pnl_pct: +ot.peakPnlPct.toFixed(2),
          btc_exit: btcCtx(),
          exit_swaps: exitSwaps,
          mcUsdLive: mcUsdLive_closeNd,
          priorityFee: pfCloseNd,
          exitContext: exitContextNd,
          ...(liqWatchNoData ? { liqWatch: liqWatchNoData } : {}),
        });
        journalLiveStrategy?.({
          kind: 'live_position_close',
          mint,
          closedTrade: serializeClosedTrade(ct),
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
        journalAppend({
          kind: 'peak',
          mint,
          peakMcUsd: ot.peakMcUsd,
          peakPnlPct: ot.peakPnlPct,
          trailingArmed: ot.trailingArmed,
        });
      }
    }

    if ((dcaLevels.length > 0 || cfg.dcaKillstop < 0) && ot.remainingFraction > 0) {
      const effPrevDrop = dcaEffPrev(ot);
      for (let dcaIdx = 0; dcaIdx < dcaLevels.length; dcaIdx++) {
        const lvl = dcaLevels[dcaIdx]!;
        if (dcaStepOrTriggerTaken(ot, dcaIdx, lvl.triggerPct)) continue;
        if (!dcaCrossedDownward(effPrevDrop, dropFromFirstPct, lvl.triggerPct)) continue;
        const addUsd = cfg.positionUsd * lvl.addFraction;
        if (livePhase4) {
          const ok = await livePhase4.trySolToTokenBuy({
            mint,
            symbol: ot.symbol,
            usdNotional: addUsd,
          });
          if (!ok) continue;
        }
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
        markDcaStepFired(ot, dcaIdx, lvl.triggerPct);
        ot.remainingFraction = 1;
        if (curMetric > ot.peakMcUsd) ot.peakMcUsd = curMetric;
        ot.peakPnlPct = (curMetric / ot.avgEntry - 1) * 100;
        ot.trailingArmed = ot.trailingArmed && curMetric / ot.avgEntry >= cfg.trailTriggerX;
        const mcUsdLive_dca = await getLiveMcUsd(
          mint,
          ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
        );
        const pfDca = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
        journalAppend({
          kind: 'dca_add',
          mint,
          ts: Date.now(),
          price: effectiveBuy,
          marketPrice: marketBuy,
          sizeUsd: addUsd,
          dcaStepIndex: dcaIdx,
          dcaLevelsTotal: dcaLevels.length,
          triggerPct: lvl.triggerPct,
          avgEntry: ot.avgEntry,
          avgEntryMarket: ot.avgEntryMarket,
          totalInvestedUsd: ot.totalInvestedUsd,
          legCount: ot.legs.length,
          mcUsdLive: mcUsdLive_dca,
          priorityFee: pfDca,
        });
        journalLiveStrategy?.({
          kind: 'live_position_dca',
          mint,
          openTrade: serializeOpenTrade(ot),
        });
        console.log(
          `[DCA] ${mint.slice(0, 8)} $${ot.symbol} +$${addUsd.toFixed(0)} @trigger=${(lvl.triggerPct * 100).toFixed(0)}% step=${dcaIdx + 1}/${dcaLevels.length} avgEff=${ot.avgEntry.toFixed(8)}`,
        );
      }
    }

    if (tpLadder.length > 0 && ot.remainingFraction > 0) {
      for (let stepIdx = 0; stepIdx < tpLadder.length; stepIdx++) {
        const lvl = tpLadder[stepIdx]!;
        if (ladderStepOrThresholdTaken(ot, stepIdx, lvl.pnlPct)) continue;
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

          const exitPvPartial = await exitPriceVerifyGate({
            cfg,
            mint,
            symbol: ot.symbol,
            tokenDecimals: ot.tokenDecimals ?? 6,
            usdNotional: investedSoldUsd,
            snapshotPriceUsd: marketSell,
            context: 'partial_sell',
            journalAppend,
            stats,
          });
          if (exitPvPartial.defer) continue;

          if (livePhase4 && marketSell > 0 && investedSoldUsd > 1e-6) {
            const ok = await livePhase4.tryTokenToSolSell({
              mint,
              symbol: ot.symbol,
              usdNotional: investedSoldUsd,
              priceUsdPerToken: marketSell,
              decimals: ot.tokenDecimals ?? 6,
              intentKind: 'sell_partial',
            });
            if (!ok) continue;
          }

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
          markLadderStepFired(ot, stepIdx, lvl.pnlPct);
          const mcUsdLive_ps = await getLiveMcUsd(
            mint,
            ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
          );
          const pfPs = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
          journalAppend({
            kind: 'partial_sell',
            mint,
            ts: ps.ts,
            price: effectiveSell,
            marketPrice: marketSell,
            sellFraction,
            ladderStepIndex: stepIdx,
            ladderRungsTotal: tpLadder.length,
            ladderPnlPct: lvl.pnlPct,
            reason: 'TP_LADDER',
            proceedsUsd,
            grossProceedsUsd,
            pnlUsd,
            grossPnlUsd,
            remainingFraction: ot.remainingFraction,
            mcUsdLive: mcUsdLive_ps,
            priorityFee: pfPs,
            ...(exitPvPartial.verdict ? { priceVerifyExit: exitPvPartial.verdict } : {}),
          });
          journalLiveStrategy?.({
            kind: 'live_position_partial_sell',
            mint,
            openTrade: serializeOpenTrade(ot),
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
    else if (cfg.trailMode === 'ladder_retrace' && ladderRetraceTriggered(ot, tpLadder, xAvg))
      exitReason = 'TRAIL';
    else if (cfg.trailMode === 'peak' && ot.trailingArmed && curMetric <= ot.peakMcUsd * (1 - cfg.trailDrop))
      exitReason = 'TRAIL';
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
      const pfClose = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
      const perTxClose = pfClose.usd > 0 ? pfClose.usd : cfg.networkFeeUsd;
      const ct = buildClosedTrade({
        cfg,
        ot,
        marketSell,
        effectiveSell,
        exitReason,
        ageH,
        networkFeeUsdPerTx: perTxClose,
      });
      const exitContextMain = buildExitContext({
        cfg,
        ot,
        closePnlPct: ct.pnlPct,
        ageH,
        exitReason,
        curMetric,
        xAvg,
        tpLadder,
      });
      ct.exitContext = exitContextMain;
      const exitPvClose = await exitPriceVerifyGate({
        cfg,
        mint,
        symbol: ot.symbol,
        tokenDecimals: ot.tokenDecimals ?? 6,
        usdNotional: investedRemaining,
        snapshotPriceUsd: marketSell,
        context: 'close',
        journalAppend,
        stats,
      });
      if (exitPvClose.defer) continue;

      if (livePhase4 && marketSell > 0 && investedRemaining > 1e-6) {
        const ok = await livePhase4.tryTokenToSolSell({
          mint,
          symbol: ot.symbol,
          usdNotional: investedRemaining,
          priceUsdPerToken: marketSell,
          decimals: ot.tokenDecimals ?? 6,
          intentKind: 'sell_full',
        });
        if (!ok) continue;
      }
      open.delete(mint);
      closed.push(ct);
      const statKey: ExitReason = exitReason === 'KILLSTOP' ? 'SL' : exitReason;
      if (stats.closed[statKey] != null) stats.closed[statKey]++;
      const mcUsdLive_close = await getLiveMcUsd(
        mint,
        ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
      );
      const liqWatchExit = await buildOptionalLiqWatchCloseStamp(cfg, ot);
      journalAppend({
        kind: 'close',
        ...ct,
        peak_pnl_pct: +ot.peakPnlPct.toFixed(2),
        btc_exit: btcCtx(),
        exit_market_price: marketSell,
        exit_effective_price: effectiveSell,
        exit_swaps: exitSwaps,
        mcUsdLive: mcUsdLive_close,
        priorityFee: pfClose,
        exitContext: exitContextMain,
        ...(liqWatchExit ? { liqWatch: liqWatchExit } : {}),
        ...(exitPvClose.verdict ? { priceVerifyExit: exitPvClose.verdict } : {}),
      });
      journalLiveStrategy?.({
        kind: 'live_position_close',
        mint,
        closedTrade: serializeClosedTrade(ct),
      });
      peakStateByMint.delete(mint);
      const arrow = ct.pnlPct >= 0 ? '+' : '';
      console.log(
        `[${exitReason}] ${mint.slice(0, 8)} $${ot.symbol} pnl_net=${arrow}${ct.pnlPct.toFixed(1)}%/$${ct.netPnlUsd.toFixed(2)} legs=${ot.legs.length} sells=${ot.partialSells.length} age=${ageH.toFixed(1)}h`,
      );
    }

    if (curMetric > 0 && open.has(mint) && Number.isFinite(dropFromFirstPct)) {
      const ote = open.get(mint);
      if (ote) ote.dcaLastEvalDropFromFirstPct = dropFromFirstPct;
    }
  }
}

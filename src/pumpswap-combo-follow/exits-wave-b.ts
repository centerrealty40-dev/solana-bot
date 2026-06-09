import { alertComboTradeLoss } from '../pumpswap-combo/alerts.js';
import { pnlPctVsAvgFill, quoteExitPriceUsd } from '../pumpswap-combo/pricing.js';
import { recordRealizedPnl, updateBotPeak } from '../pumpswap-combo/risk.js';
import { investedUsd } from '../pumpswap-combo/state.js';
import { comboLiveBridge } from '../pumpswap-combo/live-bridge.js';
import {
  WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC,
  WAVE_B_TRAIL_FLUSH_REMAIN_USD,
  WAVE_B_V1_TP_GRID,
  clampLiveTrackerMtmForExit,
  waveBAdjustSellFractionForRemainder,
  waveBBreakevenExitEligible,
  waveBDefensiveTrailActive,
  waveBMarkTrailLevelTaken,
  waveBMaybeResetTpImpulse,
  waveBNextTrailLevelToFire,
  waveBOnNewHigh,
  waveBOnTpGridRungExecuted,
  waveBRecoverPhantomPeakIfNeeded,
  waveBTrailLevelTaken,
  waveBSellFractionForStep,
} from '../papertrader/executor/exit-policy-wave-b.js';
import { LADDER_PNL_EPS } from '../papertrader/executor/tp-ladder-state.js';
import type { PumpswapComboFollowConfig } from './config.js';
import { toComboExecutorConfig } from './config.js';
import { executeFollowSell } from './executor.js';
import { appendFollowEvent } from './journal.js';
import { paperInvestedRemainingUsd, paperPoolExitQuoteUsd, paperPnlPctVsAvg } from './paper-pricing.js';
import {
  ensureFollowWaveBState,
  followAvgFillUsd,
  followLadderTaken,
  followPnlFracVsAvg,
  followRemainderNetUsd,
  markFollowLadderFired,
  type FollowWaveBState,
} from './follow-wave-b-state.js';
import {
  followStateAsCombo,
  setFollowLossCooldown,
  writeFollowState,
  type FollowState,
} from './state.js';
import type { FollowPosition } from './types.js';
import type { ComboPosition } from '../pumpswap-combo/types.js';

/** Minimal OpenTrade shim so wave-B helpers can run on follow positions. */
function waveBShim(pos: FollowPosition, wb: FollowWaveBState) {
  return {
    mint: pos.mint,
    symbol: pos.symbol,
    legs: pos.legs.map((l, i) => ({ reason: i === 0 ? 'open' : 'dca', sizeUsd: l.usd, price: l.fillPriceUsd })),
    ladderUsedIndices: new Set(wb.ladderUsedIndices),
    ladderUsedLevels: new Set(wb.ladderUsedLevels),
    liveWaveTrailLevelsTaken: wb.trailLevelsTaken,
    liveWavePeakPnlFrac: wb.peakPnlFrac,
    liveWaveTrailAnchorPnlFrac: wb.trailAnchorPnlFrac,
    liveWaveMaxExecutedTpFrac: wb.maxExecutedTpFrac,
    trailingArmed: wb.trailingArmed,
    lastObservedPriceUsd: wb.lastObservedPriceUsd,
    liveExitPolicyId: 'wave_b_v1' as const,
    avgEntry: followAvgFillUsd(pos),
    totalInvestedUsd: pos.legs.reduce((s, l) => s + l.usd, 0),
    remainingFraction: pos.remainingFrac,
    partialSells: [] as { reason: string }[],
  };
}

function syncShimBack(wb: FollowWaveBState, shim: ReturnType<typeof waveBShim>): void {
  wb.ladderUsedIndices = [...shim.ladderUsedIndices];
  wb.ladderUsedLevels = [...shim.ladderUsedLevels];
  wb.trailLevelsTaken = shim.liveWaveTrailLevelsTaken ?? [];
  wb.peakPnlFrac = shim.liveWavePeakPnlFrac ?? 0;
  wb.trailAnchorPnlFrac = shim.liveWaveTrailAnchorPnlFrac ?? 0;
  wb.maxExecutedTpFrac = shim.liveWaveMaxExecutedTpFrac ?? 0;
  wb.trailingArmed = Boolean(shim.trailingArmed);
  wb.lastObservedPriceUsd = shim.lastObservedPriceUsd;
}

async function resolveExitMark(
  cfg: PumpswapComboFollowConfig,
  pos: FollowPosition,
  liveCfg: ReturnType<typeof comboLiveBridge>,
): Promise<number | null> {
  if (cfg.executionMode === 'paper') {
    const q = await paperPoolExitQuoteUsd({ rpcUrl: cfg.rpcUrl, pos });
    return q.priceUsd;
  }
  const q = await quoteExitPriceUsd(liveCfg, pos.mint, pos.poolAddress);
  return q.priceUsd;
}

async function closeFollowPosition(args: {
  cfg: PumpswapComboFollowConfig;
  state: FollowState;
  pos: FollowPosition;
  mark: number;
  pnlPct: number;
  inv: number;
  exitReason: string;
  intent: 'tp2_full' | 'stop_loss';
  closedMints: Set<string>;
}): Promise<void> {
  const { cfg, state, pos, mark, pnlPct, inv, exitReason, intent, closedMints } = args;
  const execCfg = toComboExecutorConfig(cfg);
  const comboState = followStateAsCombo(state);

  const res = await executeFollowSell({
    cfg,
    pos,
    markPriceUsd: mark,
    exitReason,
    intent,
    sellFrac: 1,
  });
  if (!res.ok) return;

  closedMints.add(pos.mint);
  const realized = res.pnlUsd ?? inv * (pnlPct / 100);
  recordRealizedPnl(comboState, realized);
  state.realizedPnlUsd = comboState.realizedPnlUsd;
  if (realized < 0) {
    setFollowLossCooldown(cfg, state, pos.mint, Date.now());
    if (cfg.executionMode === 'live') {
      void alertComboTradeLoss(execCfg, {
        mint: pos.mint,
        symbol: pos.symbol,
        pnlUsd: realized,
        exitReason,
      });
    }
  }
  appendFollowEvent(cfg, {
    kind: 'round_trip',
    mode: cfg.executionMode,
    mint: pos.mint,
    symbol: pos.symbol,
    legs: pos.legs.length,
    investedUsd: inv,
    pnlUsd: realized,
    pnlPct,
    exitReason,
    markSource: 'pool_quote',
    holdSec: Math.round((Date.now() - pos.openedAt) / 1000),
  });
}

async function partialFollowSell(args: {
  cfg: PumpswapComboFollowConfig;
  pos: FollowPosition;
  mark: number;
  pnlPct: number;
  sellFrac: number;
  exitReason: string;
  intent: 'tp1_partial' | 'tp2_full';
}): Promise<boolean> {
  const { cfg, pos, mark, pnlPct, sellFrac, exitReason, intent } = args;
  const res = await executeFollowSell({
    cfg,
    pos,
    markPriceUsd: mark,
    exitReason,
    intent,
    sellFrac,
  });
  if (!res.ok) return false;
  appendFollowEvent(cfg, {
    kind: intent === 'tp2_full' || pos.remainingFrac <= 1e-6 ? 'close' : 'partial_sell',
    mode: cfg.executionMode,
    mint: pos.mint,
    symbol: pos.symbol,
    exitReason,
    intent,
    sellFrac,
    markPriceUsd: mark,
    markSource: 'pool_quote',
    pnlUsd: res.pnlUsd,
    pnlPct,
    remainingFrac: pos.remainingFrac,
    exitPolicy: 'oscar_wave_b',
  });
  return true;
}

export async function evaluateFollowExitsWaveB(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
): Promise<void> {
  const execCfg = toComboExecutorConfig(cfg);
  const liveCfg = comboLiveBridge(execCfg);
  const closedMints = new Set<string>();
  const comboState = followStateAsCombo(state);
  const stepPnl = WAVE_B_V1_TP_GRID.gridStepPnl;
  const trailSellFrac = cfg.waveBTrailSellFraction;

  for (const pos of state.positions) {
    if (closedMints.has(pos.mint) || pos.remainingFrac <= 1e-6) continue;

    let mark = await resolveExitMark(cfg, pos, liveCfg);
    if (mark == null) continue;

    const wb = ensureFollowWaveBState(pos);
    const shim = waveBShim(pos, wb);
    const rawMark = mark;
    mark = clampLiveTrackerMtmForExit(shim as never, mark);
    if (mark > 0) wb.lastObservedPriceUsd = mark;

    const comboPos = comboState.positions.find((p) => p.mint === pos.mint) as ComboPosition;
    updateBotPeak(comboPos, mark);
    pos.botPeakUsd = comboPos.botPeakUsd;

    const pnlPct =
      cfg.executionMode === 'paper' ? paperPnlPctVsAvg(pos, mark) : pnlPctVsAvgFill(comboPos, mark);
    const pnlFrac = followPnlFracVsAvg(pos, mark);
    const inv =
      cfg.executionMode === 'paper' ? paperInvestedRemainingUsd(pos) : investedUsd(comboPos);

    if (waveBRecoverPhantomPeakIfNeeded(shim as never, pnlFrac)) {
      syncShimBack(wb, shim);
    }

    waveBOnNewHigh(shim as never, pnlFrac, stepPnl);
    syncShimBack(wb, shim);

    if (cfg.dcaKillstopPct > 0 && pnlPct <= -cfg.dcaKillstopPct) {
      await closeFollowPosition({
        cfg,
        state,
        pos,
        mark,
        pnlPct,
        inv,
        exitReason: 'killstop',
        intent: 'stop_loss',
        closedMints,
      });
      continue;
    }

    waveBMaybeResetTpImpulse(shim as never, pnlFrac, stepPnl);
    syncShimBack(wb, shim);

    let maxK = Math.floor((pnlFrac + LADDER_PNL_EPS) / stepPnl);
    for (let k = 1; k <= maxK; k++) {
      const threshold = k * stepPnl;
      if (followLadderTaken(wb, k - 1, threshold)) continue;
      if (pnlFrac + LADDER_PNL_EPS < threshold) break;

      const remainUsd = followRemainderNetUsd(pos, mark);
      let sellFrac = waveBAdjustSellFractionForRemainder(remainUsd, waveBSellFractionForStep(k));
      if (remainUsd <= WAVE_B_TRAIL_FLUSH_REMAIN_USD) sellFrac = 1;

      const ok = await partialFollowSell({
        cfg,
        pos,
        mark,
        pnlPct,
        sellFrac,
        exitReason: `tp_grid_+${(threshold * 100).toFixed(1)}`,
        intent: sellFrac >= 1 - 1e-9 ? 'tp2_full' : 'tp1_partial',
      });
      if (!ok) break;

      markFollowLadderFired(wb, k - 1, threshold);
      waveBOnTpGridRungExecuted(shim as never, threshold);
      syncShimBack(wb, shim);

      if (pos.remainingFrac <= 1e-6) {
        closedMints.add(pos.mint);
        break;
      }
      break;
    }

    if (closedMints.has(pos.mint) || pos.remainingFrac <= 1e-6) continue;

    if (waveBDefensiveTrailActive(shim as never, stepPnl)) {
      wb.trailingArmed = true;
      const peakFrac = wb.peakPnlFrac;
      if (pnlFrac < peakFrac - LADDER_PNL_EPS) {
        const anchor = wb.trailAnchorPnlFrac;
        const level = waveBNextTrailLevelToFire(
          anchor,
          stepPnl,
          pnlFrac,
          wb.trailLevelsTaken,
          true,
        );
        if (level != null && !waveBTrailLevelTaken(shim as never, level)) {
          const remainUsd = followRemainderNetUsd(pos, mark);
          let sellFrac = waveBAdjustSellFractionForRemainder(remainUsd, trailSellFrac);
          if (remainUsd <= WAVE_B_TRAIL_FLUSH_REMAIN_USD) sellFrac = 1;
          const ok = await partialFollowSell({
            cfg,
            pos,
            mark,
            pnlPct,
            sellFrac,
            exitReason: `trail_${(level * 100).toFixed(1)}`,
            intent: sellFrac >= 1 - 1e-9 ? 'tp2_full' : 'tp1_partial',
          });
          if (ok) {
            waveBMarkTrailLevelTaken(shim as never, level);
            syncShimBack(wb, shim);
            if (pos.remainingFrac <= 1e-6) closedMints.add(pos.mint);
          }
        }
      }
    }

    if (closedMints.has(pos.mint) || pos.remainingFrac <= 1e-6) continue;

    shim.liveWaveMaxExecutedTpFrac = wb.maxExecutedTpFrac;
    if (
      waveBBreakevenExitEligible(shim as never, stepPnl) &&
      pnlPct <= 0 &&
      wb.maxExecutedTpFrac + LADDER_PNL_EPS >= WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC
    ) {
      await closeFollowPosition({
        cfg,
        state,
        pos,
        mark,
        pnlPct,
        inv,
        exitReason: 'breakeven_exit',
        intent: 'tp2_full',
        closedMints,
      });
    }

    void rawMark;
  }

  if (closedMints.size) {
    state.positions = state.positions.filter((p) => !closedMints.has(p.mint));
  }
  writeFollowState(cfg, state);
}

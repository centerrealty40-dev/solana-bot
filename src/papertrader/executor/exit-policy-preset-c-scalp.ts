/**
 * Preset C scalp exit policy — levels vs TG/signal anchor (not avg entry).
 *
 * +5%:   sell 50%, arm defensive trail from peak.
 * +10%:  sell 50% of remainder.
 * +15%:  sell 100%.
 * 0%:    full exit at breakeven vs signal (price recovered to signal anchor).
 * −50%:  kill stop vs signal anchor.
 * Trail (after +5%): each −2.5% retrace from peak → sell 50% of remainder (one level per tick).
 */
import type { PaperTraderConfig } from '../config.js';
import type { OpenTrade } from '../types.js';
import { isLiveOscarPresetCStrategyId } from '../../preset-c/live-oscar-family.js';
import {
  isPresetCScalpModeEnabled,
  loadPresetCScalpConfig,
  PRESET_C_SCALP_POLICY_ID,
  type PresetCScalpConfig,
} from '../../preset-c/scalp-config.js';
import { LADDER_PNL_EPS } from './tp-ladder-state.js';
import {
  waveBMarkTrailLevelTaken,
  waveBNextTrailLevelToFire,
  waveBOnNewHigh,
  waveBRemainderValueNetUsd,
  waveBTrailLevelTaken,
} from './exit-policy-wave-b.js';

export function isPresetCScalpExitPolicy(ot: OpenTrade): boolean {
  return ot.liveExitPolicyId === PRESET_C_SCALP_POLICY_ID;
}

export function presetCScalpAnchorPriceUsd(ot: OpenTrade): number {
  const a = ot.presetCScalpAnchorPriceUsd;
  if (a != null && a > 0) return a;
  const sig = ot.liveStagedEntry?.signalPriceUsd;
  if (sig != null && sig > 0) return sig;
  if (ot.avgEntryMarket > 0) return ot.avgEntryMarket;
  return ot.legs[0]?.marketPrice ?? ot.legs[0]?.price ?? ot.avgEntry ?? 0;
}

/** PnL fraction vs signal anchor (not avg entry). */
export function presetCScalpSignalPnlFrac(ot: OpenTrade, marketPx: number): number {
  const anchor = presetCScalpAnchorPriceUsd(ot);
  if (!(anchor > 0) || !(marketPx > 0)) return 0;
  return marketPx / anchor - 1;
}

export function stampPresetCScalpExitPolicyOnOpen(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
  anchorPriceUsd?: number,
): boolean {
  if (!isPresetCScalpModeEnabled(cfg)) return false;
  ot.liveExitPolicyId = PRESET_C_SCALP_POLICY_ID;
  if (anchorPriceUsd != null && anchorPriceUsd > 0) {
    ot.presetCScalpAnchorPriceUsd = anchorPriceUsd;
  }
  ot.tpGridOverrides = {
    ...ot.tpGridOverrides,
    gridStepPnl: 0,
    gridSellFractionByStep: [],
  };
  ot.liveWavePeakPnlFrac = 0;
  ot.liveWaveTrailAnchorPnlFrac = 0;
  ot.liveWaveTrailLevelsTaken = [];
  ot.trailingArmed = false;
  return true;
}

/** Preset C scalp: allow 50% partials on ~$100 legs without dust-flush to 100%. */
const PRESET_C_SCALP_DUST_FLUSH_USD = 25;

function presetCScalpSellFraction(remainingValueNetUsd: number, requestedFraction: number): number {
  if (!(requestedFraction > 1e-12)) return 0;
  if (remainingValueNetUsd <= PRESET_C_SCALP_DUST_FLUSH_USD) return 1;
  const frac = Math.min(1, requestedFraction);
  const afterRemainUsd = remainingValueNetUsd * (1 - frac);
  if (afterRemainUsd > 0 && afterRemainUsd < PRESET_C_SCALP_DUST_FLUSH_USD) return 1;
  return frac;
}

function fracFromPct(pct: number): number {
  return pct / 100;
}

export function presetCScalpEffectiveKillFrac(scalp: PresetCScalpConfig): number {
  return -fracFromPct(scalp.killPct);
}

export function presetCScalpKillEligible(
  ot: OpenTrade,
  marketPx: number,
  scalp: PresetCScalpConfig = loadPresetCScalpConfig(),
): boolean {
  if (!isPresetCScalpExitPolicy(ot)) return false;
  return presetCScalpSignalPnlFrac(ot, marketPx) <= presetCScalpEffectiveKillFrac(scalp) + 1e-9;
}

export function presetCScalpBreakevenExitEligible(
  ot: OpenTrade,
  marketPx: number,
): boolean {
  if (!isPresetCScalpExitPolicy(ot)) return false;
  return presetCScalpSignalPnlFrac(ot, marketPx) <= 0 + LADDER_PNL_EPS;
}

export type PresetCScalpExitAction =
  | { kind: 'none' }
  | { kind: 'full_exit'; reason: 'TP' | 'BREAKEVEN_EXIT' | 'KILLSTOP' | 'TRAIL' }
  | { kind: 'partial'; sellFraction: number; label: string; mark: () => void };

/**
 * One exit action per tracker tick (partial or full).
 * Uses signal-anchor PnL; remainder sizing uses avg-entry MTM like wave B.
 */
export function evaluatePresetCScalpExitAction(
  ot: OpenTrade,
  _cfg: PaperTraderConfig,
  marketPx: number,
  scalp: PresetCScalpConfig = loadPresetCScalpConfig(),
): PresetCScalpExitAction {
  if (!isPresetCScalpExitPolicy(ot) || !(marketPx > 0) || ot.remainingFraction <= 1e-6) {
    return { kind: 'none' };
  }

  const pnl = presetCScalpSignalPnlFrac(ot, marketPx);
  const tp2 = fracFromPct(scalp.tp2Pct);
  const tpMid = fracFromPct(scalp.tpMidPct);
  const tp3 = fracFromPct(scalp.tp3Pct);

  if (presetCScalpKillEligible(ot, marketPx, scalp)) {
    return { kind: 'full_exit', reason: 'KILLSTOP' };
  }

  if (pnl + LADDER_PNL_EPS >= tp3) {
    return { kind: 'full_exit', reason: 'TP' };
  }

  if (
    presetCScalpBreakevenExitEligible(ot, marketPx) &&
    (ot.presetCScalpTp5Taken || ot.presetCScalpTp10Taken)
  ) {
    return { kind: 'full_exit', reason: 'BREAKEVEN_EXIT' };
  }

  const remainUsd = waveBRemainderValueNetUsd(ot, marketPx);
  const adj = (frac: number) => presetCScalpSellFraction(remainUsd, frac);

  if (!ot.presetCScalpTp5Taken && pnl + LADDER_PNL_EPS >= tp2) {
    return {
      kind: 'partial',
      sellFraction: adj(0.5),
      label: `PresetC scalp TP +${scalp.tp2Pct}% (50% remain, trail arm)`,
      mark: () => {
        ot.presetCScalpTp5Taken = true;
        ot.presetCScalpTrailArmed = true;
        ot.trailingArmed = true;
        ot.liveWavePeakPnlFrac = Math.max(ot.liveWavePeakPnlFrac ?? 0, pnl);
        ot.liveWaveTrailAnchorPnlFrac = Math.max(ot.liveWaveTrailAnchorPnlFrac ?? 0, pnl);
      },
    };
  }

  if (
    ot.presetCScalpTp5Taken &&
    !ot.presetCScalpTp10Taken &&
    pnl + LADDER_PNL_EPS >= tpMid
  ) {
    return {
      kind: 'partial',
      sellFraction: adj(0.5),
      label: `PresetC scalp TP +${scalp.tpMidPct}% (50% of remainder)`,
      mark: () => {
        ot.presetCScalpTp10Taken = true;
        ot.liveWavePeakPnlFrac = Math.max(ot.liveWavePeakPnlFrac ?? 0, pnl);
        ot.liveWaveTrailAnchorPnlFrac = Math.max(ot.liveWaveTrailAnchorPnlFrac ?? 0, pnl);
      },
    };
  }

  if (ot.presetCScalpTrailArmed && scalp.trailStepPnl > 0) {
    waveBOnNewHigh(ot, pnl, scalp.trailStepPnl);
    const peak = ot.liveWavePeakPnlFrac ?? pnl;
    if (pnl < peak - LADDER_PNL_EPS) {
      const anchor = ot.liveWaveTrailAnchorPnlFrac ?? peak;
      const level = waveBNextTrailLevelToFire(
        anchor,
        scalp.trailStepPnl,
        pnl,
        ot.liveWaveTrailLevelsTaken ?? [],
        true,
      );
      if (level != null && !waveBTrailLevelTaken(ot, level)) {
        return {
          kind: 'partial',
          sellFraction: adj(scalp.trailSellFraction),
          label: `PresetC scalp trail −${(scalp.trailStepPnl * 100).toFixed(1)}% from peak`,
          mark: () => waveBMarkTrailLevelTaken(ot, level),
        };
      }
    }
  }

  return { kind: 'none' };
}

/** Optional DCA leg at `dcaDropPct` from signal (max one add; disabled when `dcaUsd` is 0). */
export function presetCScalpDcaDue(
  ot: OpenTrade,
  marketPx: number,
  scalp: PresetCScalpConfig = loadPresetCScalpConfig(),
): boolean {
  if (!isPresetCScalpExitPolicy(ot) || ot.presetCScalpDcaLegDone) return false;
  if (!(scalp.dcaUsd > 0)) return false;
  const anchor = presetCScalpAnchorPriceUsd(ot);
  if (!(anchor > 0) || !(marketPx > 0)) return false;
  const dropPct = (1 - marketPx / anchor) * 100;
  return dropPct + 1e-6 >= scalp.dcaDropPct;
}

/** DCA leg at `dca2DropPct` from signal (after DCA1 when enabled, max one add). */
export function presetCScalpDca2Due(
  ot: OpenTrade,
  marketPx: number,
  scalp: PresetCScalpConfig = loadPresetCScalpConfig(),
): boolean {
  if (!isPresetCScalpExitPolicy(ot) || ot.presetCScalpDca2LegDone) return false;
  if (scalp.dcaUsd > 0 && !ot.presetCScalpDcaLegDone) return false;
  if (!(scalp.dca2Usd > 0)) return false;
  const anchor = presetCScalpAnchorPriceUsd(ot);
  if (!(anchor > 0) || !(marketPx > 0)) return false;
  const dropPct = (1 - marketPx / anchor) * 100;
  return dropPct + 1e-6 >= scalp.dca2DropPct;
}

export function presetCScalpEffectiveExitParams(
  cfg: PaperTraderConfig,
): Pick<PaperTraderConfig, 'dcaKillstop' | 'tpGridStepPnl' | 'trailMode' | 'timeoutHours'> {
  const scalp = loadPresetCScalpConfig();
  return {
    dcaKillstop: presetCScalpEffectiveKillFrac(scalp),
    tpGridStepPnl: 0,
    trailMode: 'stepped_grid',
    timeoutHours: cfg.timeoutHours,
  };
}

export function stampPresetCScalpOnOpenIfEnabled(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
  anchorPriceUsd?: number,
): boolean {
  if (!isLiveOscarPresetCStrategyId(cfg.strategyId)) return false;
  return stampPresetCScalpExitPolicyOnOpen(ot, cfg, anchorPriceUsd);
}

/**
 * Preset C scalp mode — deferred entry (−10% / −20% DCA) + dedicated exit policy.
 * Enabled via `PRESET_C_SCALP_MODE=1` on `live-oscar-preset-c` only.
 */
import type { PaperTraderConfig } from '../papertrader/config.js';
import { isLiveOscarPresetCStrategyId } from './live-oscar-family.js';

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v !== '0' && v !== 'false' && v !== 'no';
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const PRESET_C_SCALP_POLICY_ID = 'preset_c_scalp_v1' as const;

export type PresetCScalpConfig = {
  entryDropPct: number;
  dcaDropPct: number;
  dca2DropPct: number;
  entryUsd: number;
  dcaUsd: number;
  dca2Usd: number;
  /** +5% vs signal — sell 50%, arm trail. */
  tp2Pct: number;
  /** +10% vs signal — sell 50% of remainder. */
  tpMidPct: number;
  /** +15% vs signal — sell 100%. */
  tp3Pct: number;
  killPct: number;
  /** Trail retrace from peak after +5% (fraction of price, e.g. 0.025 = 2.5%). */
  trailStepPnl: number;
  trailSellFraction: number;
  maxPendingAgeMs: number;
};

export function loadPresetCScalpConfig(): PresetCScalpConfig {
  return {
    entryDropPct: Math.max(0.1, envNum('PRESET_C_SCALP_ENTRY_DROP_PCT', 10)),
    dcaDropPct: Math.max(0.1, envNum('PRESET_C_SCALP_DCA_DROP_PCT', 10)),
    dca2DropPct: Math.max(0.1, envNum('PRESET_C_SCALP_DCA2_DROP_PCT', 20)),
    entryUsd: Math.max(1, envNum('PRESET_C_SCALP_ENTRY_USD', 200)),
    dcaUsd: Math.max(0, envNum('PRESET_C_SCALP_DCA_USD', 0)),
    dca2Usd: Math.max(0, envNum('PRESET_C_SCALP_DCA2_USD', 150)),
    tp2Pct: Math.max(0.1, envNum('PRESET_C_SCALP_TP2_PCT', 5)),
    tpMidPct: Math.max(0.1, envNum('PRESET_C_SCALP_TP_MID_PCT', 10)),
    tp3Pct: Math.max(0.1, envNum('PRESET_C_SCALP_TP3_PCT', 15)),
    killPct: Math.max(1, envNum('PRESET_C_SCALP_KILL_PCT', 50)),
    trailStepPnl: Math.max(0.005, envNum('PRESET_C_SCALP_TRAIL_RETRACE_PCT', 2.5) / 100),
    trailSellFraction: Math.min(1, Math.max(0.05, envNum('PRESET_C_SCALP_TRAIL_SELL_FRAC', 0.5))),
    maxPendingAgeMs: Math.max(
      60_000,
      Math.min(6 * 60 * 60_000, envNum('PRESET_C_TELEGRAM_GATE_MAX_AGE_MS', 3_600_000)),
    ),
  };
}

export function isPresetCScalpModeEnabled(cfg: PaperTraderConfig): boolean {
  return isLiveOscarPresetCStrategyId(cfg.strategyId) && envBool('PRESET_C_SCALP_MODE', false);
}

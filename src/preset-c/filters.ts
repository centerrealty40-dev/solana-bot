/** Preset C entry geometry — pullback only (Telegram dips parity). */

export const PRESET_C_MIN_MCAP_USD = 3_000_000;
export const PRESET_C_MAX_MCAP_USD = 30_000_000;
export const PRESET_C_MAX_CAP_USD = 300_000_000;
export const PRESET_C_MIN_RETRACE_PCT = 9;
export const PRESET_C_MAX_RETRACE_PCT = 30;

/** True when mcap is a positive finite USD value (known). */
export function isPresetCMcapKnown(mcapUsd: number): boolean {
  const m = Number(mcapUsd);
  return Number.isFinite(m) && m > 0;
}

export function passesPresetCMcapBand(mcapUsd: number): boolean {
  if (!isPresetCMcapKnown(mcapUsd)) return false;
  const m = Number(mcapUsd);
  if (m + 1e-9 < PRESET_C_MIN_MCAP_USD) return false;
  if (m > PRESET_C_MAX_MCAP_USD + 1e-9) return false;
  if (m > PRESET_C_MAX_CAP_USD + 1e-9) return false;
  return true;
}

export function passesPresetCRetraceBand(retraceFromPeakPct: number): boolean {
  const r = Number(retraceFromPeakPct);
  if (!Number.isFinite(r)) return false;
  if (r + 1e-6 < PRESET_C_MIN_RETRACE_PCT) return false;
  if (r > PRESET_C_MAX_RETRACE_PCT + 1e-6) return false;
  return true;
}

export function presetCFilterReasons(args: {
  refMcapUsd: number;
  retraceFromPeakPct: number;
}): string[] {
  const reasons: string[] = [];
  const m = args.refMcapUsd;
  if (!isPresetCMcapKnown(m)) {
    reasons.push(`preset_c_mcap_below_${(PRESET_C_MIN_MCAP_USD / 1e6).toFixed(0)}m`);
    const r = args.retraceFromPeakPct;
    if (!passesPresetCRetraceBand(r)) {
      reasons.push(`preset_c_retrace_outside_${PRESET_C_MIN_RETRACE_PCT}_${PRESET_C_MAX_RETRACE_PCT}pct`);
    }
    return reasons;
  }
  if (m + 1e-9 < PRESET_C_MIN_MCAP_USD) {
    reasons.push(`preset_c_mcap_below_${(PRESET_C_MIN_MCAP_USD / 1e6).toFixed(0)}m`);
  }
  if (m > PRESET_C_MAX_MCAP_USD + 1e-9) {
    reasons.push(`preset_c_mcap_above_${(PRESET_C_MAX_MCAP_USD / 1e6).toFixed(0)}m`);
  }
  if (m > PRESET_C_MAX_CAP_USD + 1e-9) {
    reasons.push(`preset_c_cap_above_${(PRESET_C_MAX_CAP_USD / 1e6).toFixed(0)}m`);
  }
  const r = args.retraceFromPeakPct;
  if (!passesPresetCRetraceBand(r)) {
    reasons.push(`preset_c_retrace_outside_${PRESET_C_MIN_RETRACE_PCT}_${PRESET_C_MAX_RETRACE_PCT}pct`);
  }
  return reasons;
}

export function evaluatePresetCCandidateGeometry(args: {
  refMcapUsd: number;
  retraceFromPeakPct: number;
}): { pass: boolean; reasons: string[] } {
  const reasons = presetCFilterReasons(args);
  return { pass: reasons.length === 0, reasons };
}

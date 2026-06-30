/** Preset C entry geometry — pullback (Telegram dips parity) + elite spike path. */

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v !== '0' && v !== 'false' && v !== 'no';
}

function parseUtcHourRange(): { start: number; end: number } {
  const rangeRaw = process.env.PRESET_C_SPIKE_UTC_HOURS?.trim();
  if (rangeRaw) {
    const m = rangeRaw.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (m) {
      const start = Math.max(0, Math.min(23, Number(m[1])));
      const end = Math.max(0, Math.min(24, Number(m[2])));
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        return { start, end };
      }
    }
  }
  const start = Math.max(0, Math.min(23, envNum('PRESET_C_SPIKE_UTC_START', 12)));
  const end = Math.max(start + 1, Math.min(24, envNum('PRESET_C_SPIKE_UTC_END', 18)));
  return { start, end };
}

export const PRESET_C_MIN_MCAP_USD = 3_000_000;
export const PRESET_C_SPIKE_MIN_MCAP_USD = Math.max(
  PRESET_C_MIN_MCAP_USD,
  envNum('PRESET_C_SPIKE_MIN_MCAP_USD', 3_000_000),
);
export const PRESET_C_MAX_MCAP_USD = 30_000_000;
export const PRESET_C_MAX_CAP_USD = 300_000_000;
export const PRESET_C_MIN_RETRACE_PCT = 9;
export const PRESET_C_MAX_RETRACE_PCT = 30;

/** Elite spike path — spike_dump alerts only; pullback/retrace unchanged. */
export const PRESET_C_ELITE_SPIKE_ENABLED = envBool('PRESET_C_ELITE_SPIKE_ENABLED', true);
export const PRESET_C_SPIKE_DUMP_PCT_MIN = envNum('PRESET_C_SPIKE_DUMP_PCT_MIN', 10);
export const PRESET_C_SPIKE_DUMP_PCT_MAX = envNum('PRESET_C_SPIKE_DUMP_PCT_MAX', 20);
export const PRESET_C_SPIKE_MAX_ABS_PCT = envNum('PRESET_C_SPIKE_MAX_ABS_PCT', 35);
export const PRESET_C_SPIKE_UTC_WINDOW_ENABLED = envBool('PRESET_C_SPIKE_UTC_WINDOW_ENABLED', true);
const UTC_HOUR_RANGE = parseUtcHourRange();
export const PRESET_C_SPIKE_UTC_START = UTC_HOUR_RANGE.start;
export const PRESET_C_SPIKE_UTC_END = UTC_HOUR_RANGE.end;

export function isPresetCMcapKnown(mcapUsd: number): boolean {
  const m = Number(mcapUsd);
  return Number.isFinite(m) && m > 0;
}

export function passesPresetCSpikeMcapBand(mcapUsd: number): boolean {
  if (!isPresetCMcapKnown(mcapUsd)) return false;
  const m = Number(mcapUsd);
  if (m + 1e-9 < PRESET_C_SPIKE_MIN_MCAP_USD) return false;
  if (m > PRESET_C_MAX_MCAP_USD + 1e-9) return false;
  if (m > PRESET_C_MAX_CAP_USD + 1e-9) return false;
  return true;
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

/** Elite spike dump band (10–20% by default) — absolute dump % on alert. */
export function passesPresetCEliteSpikeDumpBand(dumpPct: number): boolean {
  const d = Math.abs(Number(dumpPct));
  if (!Number.isFinite(d)) return false;
  if (d + 1e-6 < PRESET_C_SPIKE_DUMP_PCT_MIN) return false;
  if (d > PRESET_C_SPIKE_DUMP_PCT_MAX + 1e-6) return false;
  return true;
}

/** Dead-pool / glitch filter — reject |pct| >= max (default 35%). */
export function passesPresetCEliteSpikeSanity(pct: number): boolean {
  const a = Math.abs(Number(pct));
  if (!Number.isFinite(a)) return false;
  return a + 1e-6 < PRESET_C_SPIKE_MAX_ABS_PCT;
}

/** UTC hour window for elite spike entries (default 12–18 UTC, end exclusive). */
export function passesPresetCEliteSpikeUtcWindow(atMs = Date.now()): boolean {
  if (!PRESET_C_SPIKE_UTC_WINDOW_ENABLED) return true;
  const hour = new Date(atMs).getUTCHours();
  return hour >= PRESET_C_SPIKE_UTC_START && hour < PRESET_C_SPIKE_UTC_END;
}

export function presetCEliteSpikeFilterReasons(args: {
  spikeDumpPct: number;
  refMcapUsd: number;
  atMs?: number;
}): string[] {
  if (!PRESET_C_ELITE_SPIKE_ENABLED) return [];

  const reasons: string[] = [];
  const m = args.refMcapUsd;
  if (!isPresetCMcapKnown(m)) {
    reasons.push(`preset_c_mcap_below_${(PRESET_C_SPIKE_MIN_MCAP_USD / 1e6).toFixed(0)}m`);
  } else if (m + 1e-9 < PRESET_C_SPIKE_MIN_MCAP_USD) {
    reasons.push(`preset_c_mcap_below_${(PRESET_C_SPIKE_MIN_MCAP_USD / 1e6).toFixed(0)}m`);
  } else if (m > PRESET_C_MAX_MCAP_USD + 1e-9) {
    reasons.push(`preset_c_mcap_above_${(PRESET_C_MAX_MCAP_USD / 1e6).toFixed(0)}m`);
  }

  const dump = args.spikeDumpPct;
  if (!passesPresetCEliteSpikeDumpBand(dump)) {
    reasons.push(
      `preset_c_elite_spike_dump_outside_${PRESET_C_SPIKE_DUMP_PCT_MIN}_${PRESET_C_SPIKE_DUMP_PCT_MAX}pct`,
    );
  }
  if (!passesPresetCEliteSpikeSanity(dump)) {
    reasons.push(`preset_c_elite_spike_abs_pct_above_${PRESET_C_SPIKE_MAX_ABS_PCT}`);
  }
  const atMs = args.atMs ?? Date.now();
  if (!passesPresetCEliteSpikeUtcWindow(atMs)) {
    reasons.push(
      `preset_c_elite_spike_outside_utc_${PRESET_C_SPIKE_UTC_START}_${PRESET_C_SPIKE_UTC_END}`,
    );
  }
  return reasons;
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

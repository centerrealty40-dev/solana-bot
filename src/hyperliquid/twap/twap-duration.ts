import { hlTwapUnrestrictedMode } from './unrestricted.js';

/** Journal / close reason for timer exit N minutes before TWAP end. */
export const HL_TWAP_EXIT_REASON_EARLY = 'twap_early_exit';

/** Short / micro TWAP lane: flatten before whale's last 30s slice (1–2 exit slices). */
export const HL_TWAP_EXIT_REASON_SHORT = 'twap_short_before_last_slice';

function envInt(name: string, fallback: number, min = 0): number {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.round(n));
}

/** Min whale TWAP duration (minutes) for standard paper/live entry. Default 16 → skip ≤15m on long lane. */
export function twapMinMinutes(): number {
  return envInt('HL_TWAP_MIN_MINUTES', 16, 1);
}

/** Short TWAP lane: enabled when HL_TWAP_SHORT_ENABLED=1 (default on). */
export function twapShortLaneEnabled(): boolean {
  const v = process.env.HL_TWAP_SHORT_ENABLED?.trim();
  if (v == null || v === '') return true;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

/** Short lane: minutes must be **<** this (default 15 → 1–14m). */
export function twapShortMaxMinutesExclusive(): number {
  return envInt('HL_TWAP_SHORT_MAX_MINUTES', 15, 2);
}

export function twapShortMinMinutes(): number {
  return envInt('HL_TWAP_SHORT_MIN_MINUTES', 1, 1);
}

/** Legacy short lane (<15m). In unrestricted mode use {@link isMicroTwapMinutes} instead. */
export function isShortTwapMinutes(minutes: number): boolean {
  if (!twapShortLaneEnabled()) return false;
  const mins = Math.max(1, Math.round(minutes || 0));
  return mins >= twapShortMinMinutes() && mins < twapShortMaxMinutesExclusive();
}

/** Micro TWAP upper bound inclusive (default 15m). Gradual multi-slice exit only. */
export function twapMicroMaxMinutesInclusive(): number {
  return envInt('HL_TWAP_MICRO_MAX_MINUTES', 15, 1);
}

/** Standard lane starts above micro max (default >15m → 3 exit slices). */
export function twapStandardExitMinMinutesExclusive(): number {
  return twapMicroMaxMinutesInclusive() + 1;
}

/** ≤ micro max → micro schedule (exit before last whale slice). */
export function isMicroTwapMinutes(minutes: number): boolean {
  const mins = Math.max(1, Math.round(minutes || 0));
  return mins <= twapMicroMaxMinutesInclusive();
}

/** Schedule + micro exit timing (short lane legacy or unrestricted micro). */
export function shouldUseMicroExecution(minutes: number): boolean {
  if (hlTwapUnrestrictedMode()) return isMicroTwapMinutes(minutes);
  return isShortTwapMinutes(minutes);
}

/**
 * Exit slices by TWAP duration — gradual unwind, avoid single-slice book impact.
 * ≤5m: 1–2 (default 2), 6–15m: 2, >15m: 3.
 */
export function twapExitSliceCount(minutes: number): number {
  const mins = Math.max(1, Math.round(minutes || 0));
  if (mins <= 5) {
    return Math.min(2, Math.max(1, envInt('HL_TWAP_ULTRA_SHORT_EXIT_SLICES', 2, 1)));
  }
  if (mins <= twapMicroMaxMinutesInclusive()) {
    return Math.min(2, Math.max(1, envInt('HL_TWAP_MICRO_EXIT_SLICES', 2, 1)));
  }
  return Math.min(10, Math.max(1, envInt('HL_TWAP_STANDARD_EXIT_SLICES', 3, 1)));
}

/** Entry uses unified exec-slice wrapper at exchange layer; timing exit slices unchanged. */
export function twapEntrySliceCount(_minutes: number): number {
  return 1;
}

/** @deprecated use {@link twapExitSliceCount} */
export function microTwapExitSliceCount(minutes: number): number {
  return twapExitSliceCount(minutes);
}

/** Max whale TWAP duration (minutes) for paper/live entry. Default 120. */
export function twapMaxMinutes(): number {
  return envInt('HL_TWAP_MAX_MINUTES', 120, 1);
}

/** Close this many minutes before scheduled TWAP end (standard lane ≤ threshold). Default 10. */
export function twapExitEarlyMinutes(): number {
  return envInt('HL_TWAP_EXIT_EARLY_MINUTES', 10, 0);
}

/** Standard lane: fixed early below this duration (default 30m). Above → pct of TWAP length. */
export function twapExitAdaptiveThresholdMinutes(): number {
  return envInt('HL_TWAP_EXIT_ADAPTIVE_THRESHOLD_MINUTES', 30, 1);
}

/** Exit last N% of TWAP (hold the rest). Default 25 → exit when 75% elapsed. */
export function twapExitAdaptiveTailPct(): number {
  const v = process.env.HL_TWAP_EXIT_ADAPTIVE_TAIL_PCT?.trim();
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && n < 100) return n;
  }
  return 25;
}

export function twapExitAdaptiveEnabled(): boolean {
  const v = process.env.HL_TWAP_EXIT_ADAPTIVE?.trim();
  if (v == null || v === '') return true;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

/**
 * Minutes before TWAP end to start exit.
 * Micro lane: N/A (slice timing). Standard ≤30m: −10m. Standard >30m: last 25% of duration.
 */
export function twapExitEarlyMinutesForDuration(minutes: number): number {
  const mins = Math.max(1, Math.round(minutes || 0));
  if (shouldUseMicroExecution(mins)) return 0;
  if (!twapExitAdaptiveEnabled() || mins <= twapExitAdaptiveThresholdMinutes()) {
    return twapExitEarlyMinutes();
  }
  const tailPct = twapExitAdaptiveTailPct();
  return Math.max(1, Math.round((mins * tailPct) / 100));
}

/** Wait N minutes after whale TWAP cancel/error before closing (0 = immediate). Default 5. Not used on normal finish. */
export function twapCancelExitDelayMinutes(): number {
  return envInt('HL_TWAP_CANCEL_EXIT_DELAY_MINUTES', 5, 0);
}

export type TwapDurationGate = {
  allow: boolean;
  reason: string;
};

export function twapDurationGate(minutes: number): TwapDurationGate {
  const mins = Math.max(1, Math.round(minutes || 0));

  if (hlTwapUnrestrictedMode()) {
    if (isMicroTwapMinutes(mins)) return { allow: true, reason: 'ok_micro' };
    return { allow: true, reason: 'ok' };
  }

  if (isShortTwapMinutes(mins)) {
    return { allow: true, reason: 'ok_short' };
  }
  const lo = twapMinMinutes();
  const hi = twapMaxMinutes();
  if (mins < lo) return { allow: false, reason: 'twap_too_short' };
  if (mins > hi) return { allow: false, reason: 'twap_too_long' };
  const holdMin = mins - twapExitEarlyMinutesForDuration(mins);
  if (holdMin < 1) return { allow: false, reason: 'twap_hold_too_short' };
  return { allow: true, reason: 'ok' };
}

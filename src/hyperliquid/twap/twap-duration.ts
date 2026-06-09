/** Journal / close reason for timer exit N minutes before TWAP end. */
export const HL_TWAP_EXIT_REASON_EARLY = 'twap_early_exit';

/** Short TWAP lane: instant flatten before whale's last 30s slice. */
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

/** True when TWAP uses short-lane schedule + instant exit before last whale slice. */
export function isShortTwapMinutes(minutes: number): boolean {
  if (!twapShortLaneEnabled()) return false;
  const mins = Math.max(1, Math.round(minutes || 0));
  return mins >= twapShortMinMinutes() && mins < twapShortMaxMinutesExclusive();
}

/** Max whale TWAP duration (minutes) for paper/live entry. Default 120. */
export function twapMaxMinutes(): number {
  return envInt('HL_TWAP_MAX_MINUTES', 120, 1);
}

/** Close this many minutes before scheduled TWAP end (not before_last_cycle). Default 10. */
export function twapExitEarlyMinutes(): number {
  return envInt('HL_TWAP_EXIT_EARLY_MINUTES', 10, 0);
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
  if (isShortTwapMinutes(mins)) {
    return { allow: true, reason: 'ok_short' };
  }
  const lo = twapMinMinutes();
  const hi = twapMaxMinutes();
  if (mins < lo) return { allow: false, reason: 'twap_too_short' };
  if (mins > hi) return { allow: false, reason: 'twap_too_long' };
  const holdMin = mins - twapExitEarlyMinutes();
  if (holdMin < 1) return { allow: false, reason: 'twap_hold_too_short' };
  return { allow: true, reason: 'ok' };
}

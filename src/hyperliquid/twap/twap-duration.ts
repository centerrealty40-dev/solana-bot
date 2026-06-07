/** Journal / close reason for timer exit N minutes before TWAP end. */
export const HL_TWAP_EXIT_REASON_EARLY = 'twap_early_exit';

function envInt(name: string, fallback: number, min = 0): number {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.round(n));
}

/** Min whale TWAP duration (minutes) for paper/live entry. Default 16 → skip ≤15m. */
export function twapMinMinutes(): number {
  return envInt('HL_TWAP_MIN_MINUTES', 16, 1);
}

/** Max whale TWAP duration (minutes) for paper/live entry. Default 120. */
export function twapMaxMinutes(): number {
  return envInt('HL_TWAP_MAX_MINUTES', 120, 1);
}

/** Close this many minutes before scheduled TWAP end (not before_last_cycle). Default 10. */
export function twapExitEarlyMinutes(): number {
  return envInt('HL_TWAP_EXIT_EARLY_MINUTES', 10, 0);
}

/** Wait N minutes after whale TWAP cancel/end before closing (0 = immediate). Default 2. */
export function twapCancelExitDelayMinutes(): number {
  return envInt('HL_TWAP_CANCEL_EXIT_DELAY_MINUTES', 2, 0);
}

export type TwapDurationGate = {
  allow: boolean;
  reason: string;
};

export function twapDurationGate(minutes: number): TwapDurationGate {
  const mins = Math.max(1, Math.round(minutes || 0));
  const lo = twapMinMinutes();
  const hi = twapMaxMinutes();
  if (mins < lo) return { allow: false, reason: 'twap_too_short' };
  if (mins > hi) return { allow: false, reason: 'twap_too_long' };
  const holdMin = mins - twapExitEarlyMinutes();
  if (holdMin < 1) return { allow: false, reason: 'twap_hold_too_short' };
  return { allow: true, reason: 'ok' };
}

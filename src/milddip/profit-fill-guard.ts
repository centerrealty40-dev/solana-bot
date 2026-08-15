import type { MildDipExitReason } from './gates.js';

const PROFIT_FILL_GUARD_REASONS: ReadonlySet<MildDipExitReason> = new Set([
  'tp_grid',
  'mfe_bank_1',
  'mfe_bank_2',
  'mfe_bank_sleeve',
  'peak_giveback',
  'peak_giveback_partial',
]);
const LOSS_FILL_GUARD_REASONS: ReadonlySet<MildDipExitReason> = new Set([
  'never_arm_bounce',
  'cliff_dump',
  'dead_set_bounce',
  'mfe_bank_sleeve',
]);

/**
 * Return the lowest acceptable quote for a profit or bounce-based loss
 * decision. Terminal loss exits intentionally return null.
 */
export function profitFillMinPriceUsd(args: {
  reason: MildDipExitReason;
  gainPct: number;
  decisionPriceUsd: number;
  maxSlipPct: number;
  mode?: 'profit' | 'loss';
}): number | null {
  const mode = args.mode ?? 'profit';
  const reasons = mode === 'loss' ? LOSS_FILL_GUARD_REASONS : PROFIT_FILL_GUARD_REASONS;
  if (
    args.maxSlipPct <= 0 ||
    !reasons.has(args.reason) ||
    (mode === 'profit' ? args.gainPct < 0 : args.gainPct >= 0) ||
    !(args.decisionPriceUsd > 0)
  ) {
    return null;
  }
  return args.decisionPriceUsd * (1 - args.maxSlipPct / 100);
}

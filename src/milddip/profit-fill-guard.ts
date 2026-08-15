import type { MildDipExitReason } from './gates.js';

const PROFIT_FILL_GUARD_REASONS: ReadonlySet<MildDipExitReason> = new Set([
  'tp_grid',
  'mfe_bank_1',
  'mfe_bank_2',
  'mfe_bank_sleeve',
  'peak_giveback',
  'peak_giveback_partial',
]);

/**
 * Return the lowest acceptable quote for a green profit decision.
 * Loss exits intentionally return null and remain executable at any quote.
 */
export function profitFillMinPriceUsd(args: {
  reason: MildDipExitReason;
  gainPct: number;
  decisionPriceUsd: number;
  maxSlipPct: number;
}): number | null {
  if (
    args.maxSlipPct <= 0 ||
    !PROFIT_FILL_GUARD_REASONS.has(args.reason) ||
    args.gainPct < 0 ||
    !(args.decisionPriceUsd > 0)
  ) {
    return null;
  }
  return args.decisionPriceUsd * (1 - args.maxSlipPct / 100);
}

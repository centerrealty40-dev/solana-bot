import type { ExitReason, PartialSell } from '../papertrader/types.js';

/** Map last on-chain partial reason to a valid dashboard exit reason (never RECONCILE_ORPHAN). */
export function partialReasonToExitReason(reason: PartialSell['reason']): ExitReason {
  switch (reason) {
    case 'TRAIL_STEP':
    case 'TRAIL':
      return 'TRAIL';
    case 'FLASH_CRASH_KILL':
      return 'FLASH_CRASH_KILL';
    case 'KILLSTOP':
    case 'SL':
      return 'KILLSTOP';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'TP_LADDER':
    case 'BREAKEVEN_TRIM':
    case 'WAVE_B_BREAKEVEN_INSURANCE':
    case 'WAVE_B_PRE_ARM_NO_HALF8_PARTIAL':
    case 'WAVE_B_DIP10_FIRST_TP5_PARTIAL':
    case 'WAVE_B_POST_TP1_DERISK':
    case 'SCRATCH_FLUSH0':
    case 'SCRATCH_GAP_FLUSH':
    case 'THIN_VOL_FLUSH':
    default:
      return 'TP';
  }
}

export function livePartialSellDrainedWallet(
  sellAmountSource?: 'usd_math' | 'chain_full_balance' | 'usd_capped_by_chain',
  walletDrained?: boolean,
): boolean {
  return (
    walletDrained === true ||
    sellAmountSource === 'usd_capped_by_chain' ||
    sellAmountSource === 'chain_full_balance'
  );
}

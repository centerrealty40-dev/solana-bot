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

/**
 * True only when the partial sell actually emptied on-chain SPL for this mint.
 * `usd_capped_by_chain` alone means USD math exceeded chain — not necessarily zero balance
 * (manlet-class zombie tail when journal was synced to 0 without tail flush).
 */
export function livePartialSellDrainedWallet(
  sellAmountSource?: 'usd_math' | 'chain_full_balance' | 'usd_capped_by_chain',
  walletDrained?: boolean,
): boolean {
  return walletDrained === true || sellAmountSource === 'chain_full_balance';
}

/** True when a sell tx consumed ~all on-chain SPL for the mint (partial vs full aware). */
export function sellPipelineWalletDrained(
  intentKind: 'sell_partial' | 'sell_full',
  soldRaw: bigint,
  chainAmt: bigint,
): boolean {
  if (!(chainAmt > 0n) || !(soldRaw > 0n)) return false;
  if (intentKind === 'sell_full') return soldRaw >= chainAmt;
  return soldRaw * 100n >= chainAmt * 95n;
}

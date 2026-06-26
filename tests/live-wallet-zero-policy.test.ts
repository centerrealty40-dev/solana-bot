import { describe, expect, it } from 'vitest';
import {
  livePartialSellDrainedWallet,
  partialReasonToExitReason,
} from '../src/live/wallet-zero-policy.js';

describe('wallet-zero-policy', () => {
  it('maps partial reasons to valid exit reasons', () => {
    expect(partialReasonToExitReason('TP_LADDER')).toBe('TP');
    expect(partialReasonToExitReason('TRAIL_STEP')).toBe('TRAIL');
    expect(partialReasonToExitReason('FLASH_CRASH_KILL')).toBe('FLASH_CRASH_KILL');
    expect(partialReasonToExitReason('KILLSTOP')).toBe('KILLSTOP');
  });

  it('detects wallet drain from chain cap metadata', () => {
    expect(livePartialSellDrainedWallet('usd_capped_by_chain')).toBe(true);
    expect(livePartialSellDrainedWallet('chain_full_balance')).toBe(true);
    expect(livePartialSellDrainedWallet('usd_math')).toBe(false);
    expect(livePartialSellDrainedWallet(undefined, true)).toBe(true);
  });
});

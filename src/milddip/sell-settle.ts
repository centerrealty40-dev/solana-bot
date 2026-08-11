/**
 * Post-sell settlement: never clear `state.open` while SPL remainder > dust.
 *
 * Root orphans (1.11.763–765):
 * - half `never_arm_bounce` / `mfe_bank_sleeve` treated as full → state deleted
 * - "full" Jupiter sell ok while raw still on-chain
 * - partial path deleted on a single empty RPC read (race)
 */

import { HOLDING_DUST_RAW } from './sell-empty-guard.js';

export type SellSettleVerdict =
  | { action: 'keep_runner'; reason: 'partial_intent' | 'remainder_above_dust'; remainingRaw: bigint }
  | { action: 'flat'; reason: 'confirmed_empty'; remainingRaw: bigint }
  | { action: 'keep_runner'; reason: 'remainder_unknown'; remainingRaw: null };

export function parseTokenRaw(raw: string | null | undefined): bigint | null {
  if (raw == null || !/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * Fraction of the pre-sell balance that still counts as dust after a close.
 *
 * `HOLDING_DUST_RAW` alone is 1000 raw units — for a 6-decimal pump supply of
 * ~2e11 raw that is 5e-9 of the bag, so any rounding leftover read as a runner
 * and the exit engine kept firing sells at it.
 */
const RELATIVE_DUST_DIVISOR = 50n;

/**
 * Decide whether the bag stays tracked after a successful sell send.
 * `remainingRaw` must be a fresh on-chain read when possible.
 * `beforeRaw` (pre-sell balance) raises the dust floor to a relative one.
 */
export function settleAfterSuccessfulSell(args: {
  fraction: number;
  remainingRaw: bigint | null;
  beforeRaw?: bigint | null;
  dustRaw?: bigint;
}): SellSettleVerdict {
  const absDust = args.dustRaw ?? HOLDING_DUST_RAW;
  const relDust =
    args.beforeRaw != null && args.beforeRaw > 0n
      ? args.beforeRaw / RELATIVE_DUST_DIVISOR
      : 0n;
  const dust = relDust > absDust ? relDust : absDust;
  const rem = args.remainingRaw;

  if (rem == null) {
    // Never drop blind — a missing RPC read must not create orphans.
    return { action: 'keep_runner', reason: 'remainder_unknown', remainingRaw: null };
  }
  if (rem > dust) {
    const partial =
      Number.isFinite(args.fraction) && args.fraction > 0 && args.fraction < 1 - 1e-12;
    return {
      action: 'keep_runner',
      reason: partial ? 'partial_intent' : 'remainder_above_dust',
      remainingRaw: rem,
    };
  }
  return { action: 'flat', reason: 'confirmed_empty', remainingRaw: rem };
}

/** Mild-dip pump leftovers (exclude stables / non-strategy junk). */
export function isMildDipOrphanMint(mint: string): boolean {
  return typeof mint === 'string' && mint.endsWith('pump') && mint.length >= 32;
}

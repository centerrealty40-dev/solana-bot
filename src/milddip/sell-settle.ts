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
 * Decide whether the bag stays tracked after a successful sell send.
 * `remainingRaw` must be a fresh on-chain read when possible.
 */
export function settleAfterSuccessfulSell(args: {
  fraction: number;
  remainingRaw: bigint | null;
  dustRaw?: bigint;
}): SellSettleVerdict {
  const dust = args.dustRaw ?? HOLDING_DUST_RAW;
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

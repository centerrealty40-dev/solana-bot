/**
 * Guard against false `no_token_balance` drops right after a confirmed buy.
 *
 * Live incident (CkTFDN, 2026-08-08): mfe_bank_1 ~8s after buy saw RPC 0 balance,
 * `mild_dip_drop_empty` cleared state while ~$30 SPL remained on-chain → unmanaged
 * bag to −80%. Soft-fail sells must keep tracking unless emptiness is confirmed.
 */

export const HOLDING_DUST_RAW = 1000n;

/** Do not drop on empty-balance sell fail within this window after open. */
export const POST_BUY_EMPTY_DROP_GRACE_MS = 120_000;

export type EmptyDropVerdict = {
  drop: boolean;
  /** Journal / log reason for the decision. */
  reason: 'confirmed_empty' | 'balance_present' | 'post_buy_grace';
};

/**
 * Decide whether a failed sell with `no_token_balance` may clear `state.open`.
 * Call only after a fresh on-chain balance read (`onchainRaw`).
 */
export function verdictDropEmptyOnNoBalance(args: {
  onchainRaw: bigint;
  openedAtMs: number;
  nowMs: number;
  dustRaw?: bigint;
  graceMs?: number;
}): EmptyDropVerdict {
  const dust = args.dustRaw ?? HOLDING_DUST_RAW;
  const grace = args.graceMs ?? POST_BUY_EMPTY_DROP_GRACE_MS;
  if (args.onchainRaw > dust) {
    return { drop: false, reason: 'balance_present' };
  }
  if (args.nowMs - args.openedAtMs < grace) {
    return { drop: false, reason: 'post_buy_grace' };
  }
  return { drop: true, reason: 'confirmed_empty' };
}

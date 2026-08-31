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


/** Window in which a post-exit balance read may still replay the sold bag. */
export const POST_EXIT_ADOPT_STALE_WINDOW_MS = 120_000;

/**
 * A read identical to the bag a confirmed exit just sold is the RPC replaying a
 * pre-sell slot, not a landed fill.
 */
export function adoptReadReplaysClosedBag(args: {
  onchainRaw: bigint;
  lastExitAtMs: number | null | undefined;
  lastExitPreExitTokenRaw: string | null | undefined;
  nowMs: number;
  windowMs?: number;
}): boolean {
  const raw = args.lastExitPreExitTokenRaw;
  if (raw == null || !/^\d+$/.test(raw)) return false;
  const at = args.lastExitAtMs;
  if (at == null || !(at > 0)) return false;
  const window = args.windowMs ?? POST_EXIT_ADOPT_STALE_WINDOW_MS;
  if (args.nowMs - at > window || args.nowMs < at) return false;
  return args.onchainRaw === BigInt(raw);
}

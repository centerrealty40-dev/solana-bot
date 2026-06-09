/** On-chain leader balances at or below this are treated as flat (post-exit dust). */

export function leaderBalanceIsDust(raw: bigint, dustRaw: bigint): boolean {
  return raw > 0n && raw <= dustRaw;
}

/** Map dust to zero for flat detection and ledger reconcile. */
export function effectiveLeaderBalanceRaw(raw: bigint, dustRaw: bigint): bigint {
  return raw <= dustRaw ? 0n : raw;
}

export function resolveOurSellFraction(args: {
  leaderSellFraction: number;
  postLeaderBalanceRaw: bigint;
  dustRaw: bigint;
}): number {
  const { leaderSellFraction, postLeaderBalanceRaw, dustRaw } = args;
  if (leaderSellFraction >= 0.999) return 1;
  if (leaderBalanceIsDust(postLeaderBalanceRaw, dustRaw)) return 1;
  return leaderSellFraction;
}

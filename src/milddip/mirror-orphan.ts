export type MirrorOrphanDecision =
  | {
      close: true;
      balanceRaw: bigint;
      balanceMarketUsd: number;
    }
  | {
      close: false;
      reason: 'read_failed' | 'entry_settling' | 'balance_above_dust' | 'mark_unavailable';
    };

export function decideMirrorOrphanClose(args: {
  balanceRaw: string | null | undefined;
  markPriceUsd: number | null | undefined;
  entrySettlementAgeMs: number;
  firstClipPending: boolean;
  minSettleSec: number;
  dustUsd: number;
}): MirrorOrphanDecision {
  if (args.balanceRaw == null || !/^\d+$/.test(args.balanceRaw)) {
    return { close: false, reason: 'read_failed' };
  }
  if (
    args.firstClipPending ||
    (args.minSettleSec > 0 && args.entrySettlementAgeMs < args.minSettleSec * 1_000)
  ) {
    return { close: false, reason: 'entry_settling' };
  }
  let balanceRaw: bigint;
  try {
    balanceRaw = BigInt(args.balanceRaw);
  } catch {
    return { close: false, reason: 'read_failed' };
  }
  if (balanceRaw === 0n) {
    return { close: true, balanceRaw, balanceMarketUsd: 0 };
  }
  if (!(args.markPriceUsd != null && Number.isFinite(args.markPriceUsd) && args.markPriceUsd > 0)) {
    return { close: false, reason: 'mark_unavailable' };
  }
  const balanceMarketUsd = Number(balanceRaw) / 1e6 * args.markPriceUsd;
  if (!Number.isFinite(balanceMarketUsd) || balanceMarketUsd >= args.dustUsd) {
    return { close: false, reason: 'balance_above_dust' };
  }
  return { close: true, balanceRaw, balanceMarketUsd };
}

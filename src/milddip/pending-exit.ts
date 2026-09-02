export function shouldArmPendingExit(args: {
  enabled: boolean;
  isPartial: boolean;
  sellReason: string;
  guardReason: string;
}): boolean {
  return (
    args.enabled &&
    !args.isPartial &&
    args.sellReason === 'no_token_balance' &&
    (args.guardReason === 'post_buy_grace' || args.guardReason === 'balance_present')
  );
}

export function pendingExitVerdict(args: {
  pending: { reason: string; decidedAtMs: number; attempts: number } | null | undefined;
  nowMs: number;
  ttlMs: number;
  maxAttempts: number;
}): { fire: boolean; clear: boolean; reason: string | null; expiredBy: 'ttl' | 'attempts' | null } {
  if (!args.pending) {
    return { fire: false, clear: false, reason: null, expiredBy: null };
  }
  if (args.ttlMs > 0 && args.nowMs - args.pending.decidedAtMs > args.ttlMs) {
    return {
      fire: false,
      clear: true,
      reason: args.pending.reason,
      expiredBy: 'ttl',
    };
  }
  if (args.maxAttempts > 0 && args.pending.attempts >= args.maxAttempts) {
    return {
      fire: false,
      clear: true,
      reason: args.pending.reason,
      expiredBy: 'attempts',
    };
  }
  return {
    fire: true,
    clear: false,
    reason: args.pending.reason,
    expiredBy: null,
  };
}

/**
 * Space between failed copy-buy attempts. Slippage / stale blockhash need a
 * quick re-quote; RPC 429 needs a longer cool-down so we do not deepen the rate hole.
 */

export function resolveBuyRetryDelayMs(
  baseIntervalMs: number,
  reason: string | null | undefined,
): number {
  const base = Math.max(0, Math.floor(baseIntervalMs));
  if (base <= 0) return 0;
  const r = (reason ?? '').toLowerCase();
  if (!r) return base;

  if (
    r.includes('qn_rate') ||
    r.includes('too many requests') ||
    r.includes('429') ||
    r.includes('qn_budget')
  ) {
    return Math.max(base, 2_000);
  }

  if (r.includes('blockhash')) {
    return Math.min(base, 250);
  }

  if (
    r.includes('0x1771') ||
    r.includes('6001') ||
    r.includes('slippage') ||
    r.includes('sim_failed') ||
    r.includes('instructionerror')
  ) {
    return Math.min(base, 500);
  }

  return base;
}

/**
 * Adaptive Jupiter slippage bump (Oscar 1.11.503 envelope).
 * Never lowers the current allowance — control lanes at 300bps stay ≥300
 * even when LIVE_SIM_SLIPPAGE_RETRY_MAX_BPS=100.
 */
export function bumpSlippageBps(args: {
  currentBps: number;
  bumpBps: number;
  maxBps: number;
}): number {
  const current = Math.max(0, Math.floor(args.currentBps));
  if (!(args.bumpBps > 0)) return current;
  const cap = Math.max(Math.floor(args.maxBps), current);
  return Math.min(cap, current + Math.floor(args.bumpBps));
}

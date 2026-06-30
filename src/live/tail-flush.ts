/**
 * Wallet tail flush — sell 100% of on-chain SPL when remainder is small (or after full close).
 */

export type LiveTailFlushContext = 'post_close' | 'partial_exit' | 'periodic_heal';

/**
 * Whether to sell the full wallet balance for this mint.
 * - post_close: any positive remainder after journal close (orphan tail)
 * - partial_exit / periodic_heal: only when estUsd is below threshold (default $100)
 */
export function shouldLiveTailFlushWalletRemainder(args: {
  estUsd: number;
  thresholdUsd: number;
  context: LiveTailFlushContext;
}): boolean {
  const { estUsd, thresholdUsd, context } = args;
  if (!(estUsd > 0) || !Number.isFinite(estUsd)) return false;
  if (context === 'post_close') return true;
  const thr = thresholdUsd > 0 ? thresholdUsd : 100;
  return estUsd < thr;
}

/** Human-readable skip reason for JSONL when flush is not attempted. */
export function liveTailFlushSkipNote(args: {
  estUsd: number;
  thresholdUsd: number;
  context: LiveTailFlushContext;
}): string | null {
  if (!(args.estUsd > 0) || !Number.isFinite(args.estUsd)) return 'zero_balance';
  if (shouldLiveTailFlushWalletRemainder(args)) return null;
  if (args.context === 'post_close') return null;
  return 'above_threshold';
}

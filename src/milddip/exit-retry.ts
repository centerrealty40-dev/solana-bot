export function retrySlippageBpsForAttempt(args: {
  eligible: boolean;
  baseSlippageBps: number;
  priorRetryCount: number;
  stepBps: number;
  maxBps: number;
}): number | undefined {
  if (!args.eligible || args.stepBps <= 0) return undefined;
  return Math.min(
    args.maxBps,
    Math.max(1, args.baseSlippageBps + args.priorRetryCount * args.stepBps),
  );
}

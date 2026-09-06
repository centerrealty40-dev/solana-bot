export type MirrorSellFractionMode = 'full' | 'proportional' | 'skip';

export function mirrorSellFractionFromLeader(args: {
  sellFraction: number | null;
  proportionalEnabled: boolean;
  minFraction: number;
  fullFraction: number;
}): { fraction: number; mode: MirrorSellFractionMode } {
  const sellFraction = args.sellFraction;
  if (
    !args.proportionalEnabled ||
    sellFraction == null ||
    !Number.isFinite(sellFraction)
  ) {
    return { fraction: 1, mode: 'full' };
  }
  if (sellFraction >= args.fullFraction) {
    return { fraction: 1, mode: 'full' };
  }
  if (sellFraction < args.minFraction) {
    return { fraction: 0, mode: 'skip' };
  }
  return { fraction: sellFraction, mode: 'proportional' };
}

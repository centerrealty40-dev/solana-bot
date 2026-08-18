export type SignalPriceFreshnessVerdict = {
  stale: boolean;
  divergencePct: number | null;
};

export function evaluateSignalPriceFreshness(args: {
  signalPriceUsd: number | null | undefined;
  quotePriceUsd: number | null | undefined;
  markAgeMs: number | null | undefined;
  maxMarkAgeMs: number;
  maxDivergencePct: number;
}): SignalPriceFreshnessVerdict {
  const signal = args.signalPriceUsd;
  const quote = args.quotePriceUsd;
  const divergencePct =
    signal != null &&
    quote != null &&
    signal > 0 &&
    quote > 0 &&
    Number.isFinite(signal) &&
    Number.isFinite(quote)
      ? Math.abs(quote / signal - 1) * 100
      : null;
  const ageStale =
    args.maxMarkAgeMs > 0 &&
    args.markAgeMs != null &&
    Number.isFinite(args.markAgeMs) &&
    args.markAgeMs > args.maxMarkAgeMs;
  const divergenceStale =
    args.maxDivergencePct > 0 &&
    divergencePct != null &&
    divergencePct > args.maxDivergencePct;
  return {
    stale: ageStale || divergenceStale,
    divergencePct,
  };
}

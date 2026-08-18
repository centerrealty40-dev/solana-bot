import type { MildDipPriceRing } from './price-ring.js';

export type ConfirmedTroughMetrics = {
  windowMs: number;
  peakPriceUsd: number | null;
  troughPriceUsd: number | null;
  troughAtMs: number | null;
  troughAgeMs: number | null;
  bounceFromTroughPct: number | null;
  dropFromWindowHighPct: number | null;
};

export function evaluateConfirmedTrough(args: {
  ring: MildDipPriceRing;
  mint: string;
  nowMs: number;
  windowMs?: number;
  freshPriceUsd?: number | null;
}): ConfirmedTroughMetrics {
  const windowMs = Math.max(0, args.windowMs ?? 900_000);
  const peak = args.ring.maxPrice(args.mint, windowMs, args.nowMs);
  const trough = args.ring.troughAfterPeak(args.mint, windowMs, args.nowMs)?.trough ?? null;
  const fresh =
    args.freshPriceUsd != null && args.freshPriceUsd > 0
      ? args.freshPriceUsd
      : args.ring.lastPrice(args.mint, args.nowMs)?.priceUsd ?? null;
  if (!peak || !trough || !(peak.priceUsd > 0) || !(trough.priceUsd > 0)) {
    return {
      windowMs,
      peakPriceUsd: peak?.priceUsd ?? null,
      troughPriceUsd: trough?.priceUsd ?? null,
      troughAtMs: trough?.tsMs ?? null,
      troughAgeMs: trough ? Math.max(0, args.nowMs - trough.tsMs) : null,
      bounceFromTroughPct:
        trough && fresh != null ? (fresh / trough.priceUsd - 1) * 100 : null,
      dropFromWindowHighPct: null,
    };
  }
  return {
    windowMs,
    peakPriceUsd: peak.priceUsd,
    troughPriceUsd: trough.priceUsd,
    troughAtMs: trough.tsMs,
    troughAgeMs: Math.max(0, args.nowMs - trough.tsMs),
    bounceFromTroughPct:
      fresh != null ? (fresh / trough.priceUsd - 1) * 100 : null,
    dropFromWindowHighPct: (trough.priceUsd / peak.priceUsd - 1) * 100,
  };
}

export function confirmedTroughGatePasses(args: {
  metrics: ConfirmedTroughMetrics;
  minTroughAgeMs: number;
  maxBouncePct: number;
}): boolean {
  const ageOk =
    args.minTroughAgeMs <= 0 ||
    (args.metrics.troughAgeMs != null &&
      args.metrics.troughAgeMs >= args.minTroughAgeMs);
  const bounceOk =
    args.maxBouncePct >= 100 ||
    (args.metrics.bounceFromTroughPct != null &&
      args.metrics.bounceFromTroughPct <= args.maxBouncePct);
  return ageOk && bounceOk;
}

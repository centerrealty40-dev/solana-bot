import type { PriceSample } from './types.js';

export class RollingHighTracker {
  private readonly samples = new Map<string, PriceSample[]>();

  constructor(private readonly windowMs: number) {}

  push(mint: string, ts: number, priceUsd: number): void {
    if (!(priceUsd > 0)) return;
    const arr = this.samples.get(mint) ?? [];
    arr.push({ ts, priceUsd });
    const cutoff = ts - this.windowMs;
    while (arr.length > 0 && arr[0]!.ts < cutoff) arr.shift();
    this.samples.set(mint, arr);
  }

  high(mint: string): number | null {
    const arr = this.samples.get(mint);
    if (!arr?.length) return null;
    let max = 0;
    for (const s of arr) {
      if (s.priceUsd > max) max = s.priceUsd;
    }
    return max > 0 ? max : null;
  }

  dumpPct(mint: string, currentPriceUsd: number): number | null {
    const h = this.high(mint);
    if (!h || !(currentPriceUsd > 0)) return null;
    return ((currentPriceUsd / h - 1) * 100);
  }

  prune(activeMints: Set<string>): void {
    for (const mint of this.samples.keys()) {
      if (!activeMints.has(mint)) this.samples.delete(mint);
    }
  }
}

export function isDumpInBand(
  dumpPct: number,
  minPct: number,
  maxPct: number,
): boolean {
  const drop = -dumpPct;
  return drop >= minPct && drop <= maxPct;
}

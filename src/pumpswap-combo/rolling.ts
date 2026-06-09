export class RollingHighTracker {
  private readonly windowMs: number;
  private readonly samples = new Map<string, { t: number; px: number }[]>();
  private readonly botPeak = new Map<string, number>();

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  push(mint: string, tsMs: number, priceUsd: number): void {
    if (!(priceUsd > 0)) return;
    const arr = this.samples.get(mint) ?? [];
    arr.push({ t: tsMs, px: priceUsd });
    const cutoff = tsMs - this.windowMs;
    while (arr.length && arr[0]!.t < cutoff) arr.shift();
    this.samples.set(mint, arr);
    const peak = this.botPeak.get(mint) ?? 0;
    if (priceUsd > peak) this.botPeak.set(mint, priceUsd);
  }

  high15m(mint: string): number | null {
    const arr = this.samples.get(mint);
    if (!arr?.length) return null;
    return Math.max(...arr.map((s) => s.px));
  }

  dumpFromHighPct(mint: string, priceUsd: number): number | null {
    const hi = this.high15m(mint);
    if (!hi || !(priceUsd > 0)) return null;
    return ((priceUsd / hi - 1) * 100);
  }

  botPeakUsd(mint: string): number {
    return this.botPeak.get(mint) ?? 0;
  }

  dipFromBotPeakPct(mint: string, priceUsd: number): number | null {
    const peak = this.botPeakUsd(mint);
    if (!(peak > 0) || !(priceUsd > 0)) return null;
    return ((peak - priceUsd) / peak) * 100;
  }

  prune(active: Set<string>): void {
    for (const k of this.samples.keys()) {
      if (!active.has(k)) this.samples.delete(k);
    }
  }
}

export function inBand(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

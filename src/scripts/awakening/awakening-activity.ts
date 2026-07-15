/** Rolling per-mint stream signature counts (cheap pre-filter before DexScreener). */
export class MintActivityTracker {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    /** Keep events at least this long for warm-mint re-poll (>= windowMs). */
    private readonly retentionMs: number = windowMs,
  ) {}

  record(mint: string, tsMs: number = Date.now()): void {
    if (!mint) return;
    const arr = this.events.get(mint) ?? [];
    arr.push(tsMs);
    this.events.set(mint, arr);
    this.pruneMint(mint, tsMs);
  }

  count5m(mint: string, nowMs: number = Date.now()): number {
    return this.countInWindow(mint, this.windowMs, nowMs);
  }

  countInWindow(mint: string, lookbackMs: number, nowMs: number = Date.now()): number {
    this.pruneMint(mint, nowMs);
    const arr = this.events.get(mint);
    if (!arr) return 0;
    const cutoff = nowMs - lookbackMs;
    return arr.filter((t) => t >= cutoff).length;
  }

  hotMints(minSigs: number, nowMs: number = Date.now()): Array<{ mint: string; sigs: number }> {
    return this.mintsInWindow(minSigs, this.windowMs, nowMs);
  }

  warmMints(
    minSigs: number,
    lookbackMs: number,
    nowMs: number = Date.now(),
  ): Array<{ mint: string; sigs: number }> {
    return this.mintsInWindow(minSigs, lookbackMs, nowMs);
  }

  private mintsInWindow(
    minSigs: number,
    lookbackMs: number,
    nowMs: number,
  ): Array<{ mint: string; sigs: number }> {
    const out: Array<{ mint: string; sigs: number }> = [];
    for (const mint of this.events.keys()) {
      const sigs = this.countInWindow(mint, lookbackMs, nowMs);
      if (sigs >= minSigs) out.push({ mint, sigs });
    }
    out.sort((a, b) => b.sigs - a.sigs);
    return out;
  }

  pruneAll(nowMs: number = Date.now()): void {
    for (const mint of [...this.events.keys()]) {
      this.pruneMint(mint, nowMs);
      if ((this.events.get(mint)?.length ?? 0) === 0) this.events.delete(mint);
    }
  }

  size(): number {
    return this.events.size;
  }

  private pruneMint(mint: string, nowMs: number): void {
    const arr = this.events.get(mint);
    if (!arr) return;
    const cutoff = nowMs - Math.max(this.windowMs, this.retentionMs);
    const pruned = arr.filter((t) => t >= cutoff);
    if (pruned.length === 0) this.events.delete(mint);
    else this.events.set(mint, pruned);
  }
}

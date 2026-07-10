/** Rolling per-mint stream signature counts (cheap pre-filter before DexScreener). */
export class MintActivityTracker {
  private readonly events = new Map<string, number[]>();

  constructor(private readonly windowMs: number) {}

  record(mint: string, tsMs: number = Date.now()): void {
    if (!mint) return;
    const arr = this.events.get(mint) ?? [];
    arr.push(tsMs);
    this.events.set(mint, arr);
    this.pruneMint(mint, tsMs);
  }

  count5m(mint: string, nowMs: number = Date.now()): number {
    this.pruneMint(mint, nowMs);
    return this.events.get(mint)?.length ?? 0;
  }

  hotMints(minSigs: number, nowMs: number = Date.now()): Array<{ mint: string; sigs: number }> {
    const out: Array<{ mint: string; sigs: number }> = [];
    for (const mint of this.events.keys()) {
      const sigs = this.count5m(mint, nowMs);
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
    const cutoff = nowMs - this.windowMs;
    const pruned = arr.filter((t) => t >= cutoff);
    if (pruned.length === 0) this.events.delete(mint);
    else this.events.set(mint, pruned);
  }
}

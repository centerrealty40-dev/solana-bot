/**
 * In-memory ring of mints recently seen on Helius/RPC program logs.
 * Mild-dip still needs DexScreener for pc5m — the stream only builds the universe.
 */

export type HotMintHit = {
  mint: string;
  lastSeenAtMs: number;
  hits: number;
};

export class MildDipHotMintBuffer {
  private readonly byMint = new Map<string, HotMintHit>();
  private readonly maxMints: number;
  private readonly ttlMs: number;

  constructor(opts?: { maxMints?: number; ttlMs?: number }) {
    this.maxMints = opts?.maxMints ?? 400;
    this.ttlMs = opts?.ttlMs ?? 15 * 60_000;
  }

  note(mint: string, nowMs = Date.now()): void {
    if (!mint || mint.length < 32) return;
    const prev = this.byMint.get(mint);
    if (prev) {
      prev.lastSeenAtMs = nowMs;
      prev.hits += 1;
    } else {
      this.byMint.set(mint, { mint, lastSeenAtMs: nowMs, hits: 1 });
    }
    this.prune(nowMs);
  }

  list(nowMs = Date.now()): string[] {
    this.prune(nowMs);
    return [...this.byMint.values()]
      .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs || b.hits - a.hits)
      .map((h) => h.mint);
  }

  size(nowMs = Date.now()): number {
    this.prune(nowMs);
    return this.byMint.size;
  }

  private prune(nowMs: number): void {
    for (const [mint, hit] of this.byMint) {
      if (nowMs - hit.lastSeenAtMs > this.ttlMs) this.byMint.delete(mint);
    }
    if (this.byMint.size <= this.maxMints) return;
    const ordered = [...this.byMint.values()].sort((a, b) => a.lastSeenAtMs - b.lastSeenAtMs);
    const drop = ordered.length - this.maxMints;
    for (let i = 0; i < drop; i++) this.byMint.delete(ordered[i]!.mint);
  }
}

/** Process-wide buffer shared by stream callbacks and discover. */
export const mildDipHotMints = new MildDipHotMintBuffer();

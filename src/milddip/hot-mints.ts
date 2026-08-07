/**
 * In-memory ring of mints recently seen on Helius/RPC program logs.
 * Price / dip gates use the price-ring; this buffer only ranks the universe.
 * Persisted across restarts so a deploy does not wipe hot coverage.
 */
import fs from 'node:fs';
import path from 'node:path';

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

  note(mint: string, nowMs = Date.now(), hitsInc = 1): void {
    if (!mint || mint.length < 32) return;
    const prev = this.byMint.get(mint);
    if (prev) {
      prev.lastSeenAtMs = Math.max(prev.lastSeenAtMs, nowMs);
      prev.hits += hitsInc;
    } else {
      this.byMint.set(mint, { mint, lastSeenAtMs: nowMs, hits: Math.max(1, hitsInc) });
    }
    this.prune(nowMs);
  }

  list(nowMs = Date.now()): string[] {
    this.prune(nowMs);
    return [...this.byMint.values()]
      .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs || b.hits - a.hits)
      .map((h) => h.mint);
  }

  /**
   * Enrich ranking: prefer mints with more stream hits (activity), decayed by
   * age so a stale high-hit mint does not crowd out fresh tape. Fresh (&lt;60s)
   * names get a flat boost so ignition still surfaces quickly.
   */
  listForEnrich(nowMs = Date.now()): string[] {
    this.prune(nowMs);
    return [...this.byMint.values()]
      .map((h) => {
        const ageSec = Math.max(0, (nowMs - h.lastSeenAtMs) / 1000);
        const hitScore = h.hits / (1 + ageSec / 30);
        // Ultra-fresh tape (≤20s) jumps the enrich queue — race leaders on ignition.
        const freshBoost =
          ageSec <= 20 ? 120 : ageSec <= 60 ? 50 : ageSec <= 180 ? 15 : 0;
        return { mint: h.mint, score: hitScore + freshBoost };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.mint);
  }

  size(nowMs = Date.now()): number {
    this.prune(nowMs);
    return this.byMint.size;
  }

  toJSON(nowMs = Date.now()): HotMintHit[] {
    this.prune(nowMs);
    return [...this.byMint.values()];
  }

  loadHits(hits: HotMintHit[], nowMs = Date.now()): number {
    let n = 0;
    for (const h of hits) {
      if (!h?.mint || typeof h.lastSeenAtMs !== 'number') continue;
      this.note(h.mint, h.lastSeenAtMs, Math.max(1, Number(h.hits) || 1));
      n += 1;
    }
    this.prune(nowMs);
    return n;
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

export function saveMildDipHotMints(filePath: string, buf = mildDipHotMints): void {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const payload = { updatedAtMs: Date.now(), hits: buf.toJSON() };
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

export function loadMildDipHotMints(filePath: string, buf = mildDipHotMints): number {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      hits?: HotMintHit[];
    };
    return buf.loadHits(Array.isArray(raw.hits) ? raw.hits : []);
  } catch {
    return 0;
  }
}

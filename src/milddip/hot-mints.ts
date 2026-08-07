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
  /** First stream sighting in this process lifetime (or restored from disk). */
  firstSeenAtMs?: number;
  hits: number;
};

export class MildDipHotMintBuffer {
  private readonly byMint = new Map<string, HotMintHit>();
  private readonly maxMints: number;
  private readonly ttlMs: number;
  /** Mints already granted a first-seen force-enrich slot. */
  private readonly forceEnriched = new Set<string>();
  /** Timestamps of force-enrich grants (rolling 60s window). */
  private forceGrantTs: number[] = [];

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
      if (prev.firstSeenAtMs == null) prev.firstSeenAtMs = prev.lastSeenAtMs;
    } else {
      this.byMint.set(mint, {
        mint,
        lastSeenAtMs: nowMs,
        firstSeenAtMs: nowMs,
        hits: Math.max(1, hitsInc),
      });
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

  /**
   * First stream sightings not yet force-enriched, rate-limited to `maxPerMin`
   * so Dex RPM / enrich budget are not flooded. Returns [] when maxPerMin≤0.
   */
  takeForceEnrichFirstSeen(nowMs = Date.now(), maxPerMin = 0): string[] {
    if (!(maxPerMin > 0)) return [];
    this.prune(nowMs);
    const windowMs = 60_000;
    this.forceGrantTs = this.forceGrantTs.filter((t) => nowMs - t < windowMs);
    const slots = Math.max(0, Math.floor(maxPerMin) - this.forceGrantTs.length);
    if (slots <= 0) return [];

    const pending = [...this.byMint.values()]
      .filter((h) => {
        if (this.forceEnriched.has(h.mint)) return false;
        const first = h.firstSeenAtMs ?? h.lastSeenAtMs;
        // Only brand-new sightings in the last 3 minutes.
        return nowMs - first <= 180_000;
      })
      .sort((a, b) => (b.firstSeenAtMs ?? 0) - (a.firstSeenAtMs ?? 0));

    const out: string[] = [];
    for (const h of pending) {
      if (out.length >= slots) break;
      this.forceEnriched.add(h.mint);
      this.forceGrantTs.push(nowMs);
      out.push(h.mint);
    }
    return out;
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
      const cur = this.byMint.get(h.mint);
      if (cur && h.firstSeenAtMs != null) {
        cur.firstSeenAtMs = Math.min(cur.firstSeenAtMs ?? h.firstSeenAtMs, h.firstSeenAtMs);
      }
      // Restored mints already had their shot — do not stampede Dex on restart.
      this.forceEnriched.add(h.mint);
      n += 1;
    }
    this.prune(nowMs);
    return n;
  }

  private prune(nowMs: number): void {
    for (const [mint, hit] of this.byMint) {
      if (nowMs - hit.lastSeenAtMs > this.ttlMs) {
        this.byMint.delete(mint);
        this.forceEnriched.delete(mint);
      }
    }
    if (this.byMint.size <= this.maxMints) return;
    const ordered = [...this.byMint.values()].sort((a, b) => a.lastSeenAtMs - b.lastSeenAtMs);
    const drop = ordered.length - this.maxMints;
    for (let i = 0; i < drop; i++) {
      const m = ordered[i]!.mint;
      this.byMint.delete(m);
      this.forceEnriched.delete(m);
    }
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

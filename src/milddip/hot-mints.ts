/**
 * In-memory ring of mints recently seen on Helius/RPC program logs.
 * Price / dip gates use the price-ring; this buffer only ranks the universe.
 * Persisted across restarts so a deploy does not wipe hot coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { markLeaderBought } from '../volgreen/leader-mint-allowlist.js';

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
  /** Per-mint cooldown for spike re-force (avoid Dex stampede on one mint). */
  private spikeCooldownUntil = new Map<string, number>();
  private spikeGrantTs: number[] = [];
  /**
   * Mints resolved from Buy/Sell getTransaction (or Buy logs with mint) awaiting
   * force-enrich — race the candle without waiting for top-N by vol.
   */
  private buyForcePending = new Map<string, number>();

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

  /**
   * Re-force already-known mints with a live hit spike (lastSeen ≤ recentMs).
   * Caps grants/min and per-mint cooldown so we re-probe goon-class impulses
   * within seconds instead of waiting for the slow full probe cycle.
   */
  takeForceEnrichHotSpike(
    nowMs = Date.now(),
    maxPerMin = 0,
    recentMs = 12_000,
    perMintCooldownMs = 15_000,
  ): string[] {
    if (!(maxPerMin > 0)) return [];
    this.prune(nowMs);
    const windowMs = 60_000;
    this.spikeGrantTs = this.spikeGrantTs.filter((t) => nowMs - t < windowMs);
    const slots = Math.max(0, Math.floor(maxPerMin) - this.spikeGrantTs.length);
    if (slots <= 0) return [];

    const pending = [...this.byMint.values()]
      .filter((h) => {
        if (nowMs - h.lastSeenAtMs > recentMs) return false;
        const cd = this.spikeCooldownUntil.get(h.mint) ?? 0;
        return nowMs >= cd;
      })
      .sort((a, b) => b.hits - a.hits || b.lastSeenAtMs - a.lastSeenAtMs);

    const out: string[] = [];
    for (const h of pending) {
      if (out.length >= slots) break;
      this.spikeCooldownUntil.set(h.mint, nowMs + perMintCooldownMs);
      this.spikeGrantTs.push(nowMs);
      out.push(h.mint);
    }
    return out;
  }

  /** Per-mint cooldown before re-queue after a missed Dex probe. */
  private buyForceRetryAfter = new Map<string, number>();
  /** Leader-highlighted mints — evaluate first, Gecko priority (not blind copy). */
  private leaderHighlightUntil = new Map<string, number>();
  /** Large SOL buy seen via resolve — race entry without waiting for 1m bars. */
  private volumeImpulseUntil = new Map<string, { until: number; solNotional: number }>();

  /** Mark mint for next-scan force enrich (Buy activity / getTx resolve). */
  markBuyForce(mint: string, nowMs = Date.now()): void {
    if (!mint || mint.length < 32) return;
    this.buyForcePending.set(mint, nowMs);
  }

  /**
   * Large on-stream Buy (SOL notional ≥ threshold). TTL 3m — evaluate as
   * volume impulse even if local 1m bars are not ready yet.
   */
  markVolumeImpulse(mint: string, solNotional: number, nowMs = Date.now()): void {
    if (!mint || mint.length < 32) return;
    if (!(solNotional > 0)) return;
    this.markBuyForce(mint, nowMs);
    this.note(mint, nowMs, 16);
    const prev = this.volumeImpulseUntil.get(mint);
    const sol = Math.max(solNotional, prev?.solNotional ?? 0);
    this.volumeImpulseUntil.set(mint, { until: nowMs + 180_000, solNotional: sol });
  }

  isVolumeImpulse(mint: string, nowMs = Date.now()): boolean {
    const row = this.volumeImpulseUntil.get(mint);
    if (!row) return false;
    if (nowMs > row.until) {
      this.volumeImpulseUntil.delete(mint);
      return false;
    }
    return true;
  }

  volumeImpulseSol(mint: string, nowMs = Date.now()): number {
    const row = this.volumeImpulseUntil.get(mint);
    if (!row || nowMs > row.until) {
      if (row) this.volumeImpulseUntil.delete(mint);
      return 0;
    }
    return row.solNotional;
  }

  /**
   * Leader wallet Buy seen — force into enrich/triple eval. We still require
   * our gates (triple_green etc.); this only highlights the mint.
   */
  markLeaderHighlight(mint: string, nowMs = Date.now()): void {
    if (!mint || mint.length < 32) return;
    this.markBuyForce(mint, nowMs);
    this.note(mint, nowMs, 24);
    this.leaderHighlightUntil.set(mint, nowMs + 300_000);
    // Persistent allowlist: leader bought this mint at least once.
    markLeaderBought(mint, nowMs);
  }

  isLeaderHighlight(mint: string, nowMs = Date.now()): boolean {
    const until = this.leaderHighlightUntil.get(mint);
    if (until == null) return false;
    if (nowMs > until) {
      this.leaderHighlightUntil.delete(mint);
      return false;
    }
    return true;
  }

  /**
   * Re-queue a force mint whose Dex probe returned null (Dealer / 6f8ZQ miss).
   * Keeps original freshness window; 8s per-mint cooldown avoids Dex stampede.
   */
  requeueBuyForceMiss(mint: string, nowMs = Date.now()): void {
    if (!mint || mint.length < 32) return;
    const cd = this.buyForceRetryAfter.get(mint) ?? 0;
    if (nowMs < cd) return;
    this.buyForceRetryAfter.set(mint, nowMs + 8_000);
    // Do not refresh ts if already pending newer — only restore if missing.
    if (!this.buyForcePending.has(mint)) {
      this.buyForcePending.set(mint, nowMs);
    }
  }

  /**
   * Peek Buy-resolved force queue (newest first). Does NOT drain.
   * triple_green needs the same mint across several scans to build local 1m
   * bars — draining after one probe left every mint at samples=1 (zero buys).
   */
  takeForceEnrichBuyResolved(nowMs = Date.now(), maxTake = 12): string[] {
    if (!(maxTake > 0)) return [];
    this.prune(nowMs);
    // Keep ~5 min so we can accumulate ≥3 one-minute buckets.
    for (const [mint, ts] of this.buyForcePending) {
      if (nowMs - ts > 300_000) this.buyForcePending.delete(mint);
    }
    for (const [mint, until] of this.leaderHighlightUntil) {
      if (nowMs > until) this.leaderHighlightUntil.delete(mint);
    }
    // Volume impulses + leader highlights first, then newest buyForce.
    const volume: string[] = [];
    const leaders: string[] = [];
    const rest: string[] = [];
    const ordered = [...this.buyForcePending.entries()].sort((a, b) => b[1] - a[1]);
    for (const [mint] of ordered) {
      if (this.isVolumeImpulse(mint, nowMs)) volume.push(mint);
      else if (this.isLeaderHighlight(mint, nowMs)) leaders.push(mint);
      else rest.push(mint);
    }
    // Bigger SOL notional first among volume marks.
    volume.sort(
      (a, b) => this.volumeImpulseSol(b, nowMs) - this.volumeImpulseSol(a, nowMs),
    );
    const out: string[] = [];
    for (const mint of [...volume, ...leaders, ...rest]) {
      if (out.length >= maxTake) break;
      out.push(mint);
    }
    return out;
  }

  /** Drop after buy / definitive skip so the queue does not grow forever. */
  clearBuyForce(mint: string): void {
    if (!mint) return;
    this.buyForcePending.delete(mint);
    this.buyForceRetryAfter.delete(mint);
    this.leaderHighlightUntil.delete(mint);
    this.volumeImpulseUntil.delete(mint);
  }

  buyForcePendingToJSON(nowMs = Date.now()): Array<{ mint: string; tsMs: number }> {
    this.prune(nowMs);
    for (const [mint, ts] of this.buyForcePending) {
      if (nowMs - ts > 300_000) this.buyForcePending.delete(mint);
    }
    return [...this.buyForcePending.entries()].map(([mint, tsMs]) => ({ mint, tsMs }));
  }

  loadBuyForcePending(
    rows: Array<{ mint?: string; tsMs?: number }>,
    nowMs = Date.now(),
  ): number {
    let n = 0;
    for (const r of rows) {
      if (!r?.mint || typeof r.tsMs !== 'number') continue;
      if (nowMs - r.tsMs > 120_000) continue;
      this.buyForcePending.set(r.mint, r.tsMs);
      n += 1;
    }
    return n;
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
        this.buyForcePending.delete(mint);
        this.buyForceRetryAfter.delete(mint);
      }
    }
    for (const [mint, until] of this.buyForceRetryAfter) {
      if (until < nowMs - 60_000) this.buyForceRetryAfter.delete(mint);
    }
    if (this.byMint.size <= this.maxMints) return;
    const ordered = [...this.byMint.values()].sort((a, b) => a.lastSeenAtMs - b.lastSeenAtMs);
    const drop = ordered.length - this.maxMints;
    for (let i = 0; i < drop; i++) {
      const m = ordered[i]!.mint;
      this.byMint.delete(m);
      this.forceEnriched.delete(m);
      this.buyForcePending.delete(m);
      this.buyForceRetryAfter.delete(m);
    }
  }
}

/** Process-wide buffer shared by stream callbacks and discover. */
export const mildDipHotMints = new MildDipHotMintBuffer();

export function saveMildDipHotMints(filePath: string, buf = mildDipHotMints): void {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const nowMs = Date.now();
  const payload = {
    updatedAtMs: nowMs,
    hits: buf.toJSON(nowMs),
    // Survive PM2 restart — buyForce was in-memory only (Dealer miss after deploy).
    buyForcePending: buf.buyForcePendingToJSON(nowMs),
  };
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

export function loadMildDipHotMints(filePath: string, buf = mildDipHotMints): number {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      hits?: HotMintHit[];
      buyForcePending?: Array<{ mint?: string; tsMs?: number }>;
    };
    const n = buf.loadHits(Array.isArray(raw.hits) ? raw.hits : []);
    const bf = buf.loadBuyForcePending(
      Array.isArray(raw.buyForcePending) ? raw.buyForcePending : [],
    );
    if (bf > 0) {
      console.log(`[mild-dip] restored buyForcePending=${bf} from ${filePath}`);
    }
    return n;
  } catch {
    return 0;
  }
}

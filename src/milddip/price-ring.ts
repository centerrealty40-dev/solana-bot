/**
 * Per-mint price samples from Dex enrich/marks and stream-decoded swaps.
 * Used to see the trough during cooldown and skip bounce re-entries.
 */
import fs from 'node:fs';
import path from 'node:path';

export type MildDipPriceSource = 'dex' | 'stream';

export type MildDipPriceSample = {
  tsMs: number;
  priceUsd: number;
  source: MildDipPriceSource;
};

type MintRing = {
  samples: MildDipPriceSample[];
};

export class MildDipPriceRing {
  private readonly byMint = new Map<string, MintRing>();
  private readonly maxSamplesPerMint: number;
  private readonly ttlMs: number;

  constructor(opts?: { maxSamplesPerMint?: number; ttlMs?: number }) {
    this.maxSamplesPerMint = opts?.maxSamplesPerMint ?? 180;
    this.ttlMs = opts?.ttlMs ?? 15 * 60_000;
  }

  note(
    mint: string,
    priceUsd: number,
    opts?: { tsMs?: number; source?: MildDipPriceSource },
  ): void {
    if (!mint || mint.length < 32) return;
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return;
    const tsMs = opts?.tsMs ?? Date.now();
    const source = opts?.source ?? 'dex';
    let ring = this.byMint.get(mint);
    if (!ring) {
      ring = { samples: [] };
      this.byMint.set(mint, ring);
    }
    const last = ring.samples[ring.samples.length - 1];
    // Collapse near-duplicate ticks (same source, <1% move, <1.5s).
    if (
      last &&
      last.source === source &&
      tsMs - last.tsMs < 1_500 &&
      Math.abs(priceUsd / last.priceUsd - 1) < 0.01
    ) {
      last.tsMs = tsMs;
      last.priceUsd = priceUsd;
      return;
    }
    ring.samples.push({ tsMs, priceUsd, source });
    this.pruneMint(mint, tsMs);
  }

  minPrice(
    mint: string,
    windowMs: number,
    nowMs = Date.now(),
  ): MildDipPriceSample | null {
    const samples = this.samplesInWindow(mint, windowMs, nowMs);
    if (samples.length === 0) return null;
    let best = samples[0]!;
    for (const s of samples) {
      if (s.priceUsd < best.priceUsd) best = s;
    }
    return best;
  }

  maxPrice(
    mint: string,
    windowMs: number,
    nowMs = Date.now(),
  ): MildDipPriceSample | null {
    const samples = this.samplesInWindow(mint, windowMs, nowMs);
    if (samples.length === 0) return null;
    let best = samples[0]!;
    for (const s of samples) {
      if (s.priceUsd > best.priceUsd) best = s;
    }
    return best;
  }

  lastPrice(mint: string, nowMs = Date.now()): MildDipPriceSample | null {
    this.pruneMint(mint, nowMs);
    const ring = this.byMint.get(mint);
    if (!ring || ring.samples.length === 0) return null;
    return ring.samples[ring.samples.length - 1] ?? null;
  }

  /** Most recent sample with `source`, optionally within maxAgeMs. */
  lastPriceBySource(
    mint: string,
    source: MildDipPriceSource,
    nowMs = Date.now(),
    maxAgeMs = 0,
  ): MildDipPriceSample | null {
    this.pruneMint(mint, nowMs);
    const ring = this.byMint.get(mint);
    if (!ring || ring.samples.length === 0) return null;
    for (let i = ring.samples.length - 1; i >= 0; i--) {
      const s = ring.samples[i]!;
      if (s.source !== source) continue;
      if (maxAgeMs > 0 && nowMs - s.tsMs > maxAgeMs) return null;
      return s;
    }
    return null;
  }

  /**
   * Reject stream decode outliers (e.g. wrong decimals → $0.18 vs $7e-5).
   * No recent reference ⇒ allow (cold mint).
   */
  isPlausiblePrice(
    mint: string,
    priceUsd: number,
    opts?: { nowMs?: number; windowMs?: number; maxRatio?: number },
  ): boolean {
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return false;
    const nowMs = opts?.nowMs ?? Date.now();
    const windowMs = opts?.windowMs ?? 10 * 60_000;
    const maxRatio = opts?.maxRatio ?? 20;
    const samples = this.samplesInWindow(mint, windowMs, nowMs).filter(
      (s) => s.priceUsd > 0 && Number.isFinite(s.priceUsd),
    );
    if (samples.length === 0) return true;
    // Prefer dex refs; fall back to any recent sample.
    const refs = samples.filter((s) => s.source === 'dex');
    const use = refs.length > 0 ? refs : samples;
    let lo = use[0]!.priceUsd;
    let hi = use[0]!.priceUsd;
    for (const s of use) {
      if (s.priceUsd < lo) lo = s.priceUsd;
      if (s.priceUsd > hi) hi = s.priceUsd;
    }
    const floor = lo / maxRatio;
    const ceil = hi * maxRatio;
    return priceUsd >= floor && priceUsd <= ceil;
  }

  /**
   * Drawdown from local peak → last sample, as % (negative or zero).
   * e.g. peak 100 → last 90 → −10.
   */
  drawdownFromPeakPct(
    mint: string,
    windowMs: number,
    nowMs = Date.now(),
  ): number | null {
    const peak = this.maxPrice(mint, windowMs, nowMs);
    const last = this.lastPrice(mint, nowMs);
    if (!peak || !last || !(peak.priceUsd > 0)) return null;
    if (last.tsMs < nowMs - windowMs) return null;
    return (last.priceUsd / peak.priceUsd - 1) * 100;
  }

  /** Bounce from trough → fresh price, as % (≥0 when above trough). */
  bounceFromTroughPct(
    mint: string,
    freshPriceUsd: number,
    windowMs: number,
    nowMs = Date.now(),
  ): number | null {
    const trough = this.minPrice(mint, windowMs, nowMs);
    if (!trough || !(trough.priceUsd > 0) || !(freshPriceUsd > 0)) return null;
    return (freshPriceUsd / trough.priceUsd - 1) * 100;
  }

  sampleCount(mint: string, windowMs: number, nowMs = Date.now()): number {
    return this.samplesInWindow(mint, windowMs, nowMs).length;
  }

  watchedMints(nowMs = Date.now()): string[] {
    this.pruneAll(nowMs);
    return [...this.byMint.keys()];
  }

  private samplesInWindow(
    mint: string,
    windowMs: number,
    nowMs: number,
  ): MildDipPriceSample[] {
    this.pruneMint(mint, nowMs);
    const ring = this.byMint.get(mint);
    if (!ring) return [];
    const cut = nowMs - Math.max(0, windowMs);
    return ring.samples.filter((s) => s.tsMs >= cut);
  }

  private pruneMint(mint: string, nowMs: number): void {
    const ring = this.byMint.get(mint);
    if (!ring) return;
    const cut = nowMs - this.ttlMs;
    ring.samples = ring.samples.filter((s) => s.tsMs >= cut);
    if (ring.samples.length > this.maxSamplesPerMint) {
      ring.samples = ring.samples.slice(ring.samples.length - this.maxSamplesPerMint);
    }
    if (ring.samples.length === 0) this.byMint.delete(mint);
  }

  private pruneAll(nowMs: number): void {
    for (const mint of [...this.byMint.keys()]) this.pruneMint(mint, nowMs);
  }

  /** Snapshot for atomic JSON persistence. */
  toJSON(nowMs = Date.now()): Record<string, MildDipPriceSample[]> {
    this.pruneAll(nowMs);
    const out: Record<string, MildDipPriceSample[]> = {};
    for (const [mint, ring] of this.byMint) {
      if (ring.samples.length) out[mint] = ring.samples;
    }
    return out;
  }

  loadJSON(data: unknown, nowMs = Date.now()): number {
    if (!data || typeof data !== 'object') return 0;
    let n = 0;
    for (const [mint, samples] of Object.entries(data as Record<string, unknown>)) {
      if (!Array.isArray(samples)) continue;
      for (const raw of samples) {
        if (!raw || typeof raw !== 'object') continue;
        const s = raw as Partial<MildDipPriceSample>;
        if (typeof s.priceUsd !== 'number' || typeof s.tsMs !== 'number') continue;
        const source: MildDipPriceSource = s.source === 'stream' ? 'stream' : 'dex';
        this.note(mint, s.priceUsd, { tsMs: s.tsMs, source });
        n += 1;
      }
    }
    this.pruneAll(nowMs);
    return n;
  }
}

export const mildDipPriceRing = new MildDipPriceRing();

export function saveMildDipPriceRing(filePath: string, ring = mildDipPriceRing): void {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const payload = {
    updatedAtMs: Date.now(),
    mints: ring.toJSON(),
  };
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

export function loadMildDipPriceRing(filePath: string, ring = mildDipPriceRing): number {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      mints?: unknown;
    };
    return ring.loadJSON(raw.mints ?? raw);
  } catch {
    return 0;
  }
}

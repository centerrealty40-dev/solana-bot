/**
 * Per-mint price samples from Dex enrich/marks and stream-decoded swaps.
 * Used to see the trough during cooldown and skip bounce re-entries.
 */
import fs from 'node:fs';
import path from 'node:path';

export type MildDipPriceSource = 'dex' | 'stream' | 'green_jupiter' | 'leader_mirror_jupiter';

export function isAuxiliaryJupiterSource(source: MildDipPriceSource): boolean {
  return source === 'green_jupiter' || source === 'leader_mirror_jupiter';
}

export type MildDipPriceSample = {
  tsMs: number;
  priceUsd: number;
  source: MildDipPriceSource;
};

type MintRing = {
  samples: MildDipPriceSample[];
};

export type MildDipPriceWindowStats = {
  sampleCount: number;
  firstSampleTsMs: number | null;
  lastSampleTsMs: number | null;
  spanMs: number;
  minPriceUsd: number | null;
  maxPriceUsd: number | null;
};

export type MildDipStreamWindowMetrics = {
  freshPriceUsd: number | null;
  bounceFromTroughPct: number | null;
  rallyIntoPeakPct: number | null;
  dumpExtentFromPeakPct: number | null;
  sampleCount: number;
  oldestSampleAgeMs: number | null;
};

export type MildDipTapeMinuteMetrics = {
  tapeRet1mPct: number | null;
  tapePrior5mPct: number | null;
  sampleCount: number;
  coverageMs: number | null;
  latestSampleAgeMs: number | null;
  failureReason: MildDipTapeMinuteFailureReason | null;
};

export type MildDipTapeMinuteFailureReason =
  | 'tape_minute_samples_insufficient'
  | 'tape_minute_latest_stale'
  | 'tape_minute_boundary_missing'
  | 'tape_minute_prior_anchor_missing'
  | 'tape_minute_coverage_insufficient';

export type MildDipTapeMinuteOptions = {
  strictFreshness?: boolean;
  minRecentSamples?: number;
  latestMaxAgeMs?: number;
  boundaryMinAgeMs?: number;
  boundaryMaxAgeMs?: number;
  priorAnchorMinAgeMs?: number;
  priorAnchorMaxAgeMs?: number;
};

export class MildDipPriceRing {
  private readonly byMint = new Map<string, MintRing>();
  private readonly decimalsByMint = new Map<string, number>();
  private readonly tapeMinuteFailureCounts = new Map<
    MildDipTapeMinuteFailureReason,
    number
  >();
  private readonly maxSamplesPerMint: number;
  private readonly ttlMs: number;

  constructor(opts?: { maxSamplesPerMint?: number; ttlMs?: number }) {
    this.maxSamplesPerMint = opts?.maxSamplesPerMint ?? 180;
    this.ttlMs = opts?.ttlMs ?? 15 * 60_000;
  }

  tapeMinuteFailureStats(): Record<string, number> {
    return Object.fromEntries(this.tapeMinuteFailureCounts.entries());
  }

  noteMintDecimals(mint: string, decimals: number): void {
    if (!mint || !Number.isInteger(decimals) || decimals < 0 || decimals > 24) return;
    this.decimalsByMint.set(mint, decimals);
  }

  mintDecimals(mint: string): number | null {
    return this.decimalsByMint.get(mint) ?? null;
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
    for (let i = ring.samples.length - 1; i >= 0; i--) {
      const sample = ring.samples[i]!;
      if (!isAuxiliaryJupiterSource(sample.source)) return sample;
    }
    return null;
  }

  /** Latest sample at or before a lookback boundary. */
  priceAtOrBefore(
    mint: string,
    lookbackMs: number,
    nowMs = Date.now(),
  ): MildDipPriceSample | null {
    this.pruneMint(mint, nowMs);
    const ring = this.byMint.get(mint);
    if (!ring || ring.samples.length === 0) return null;
    const boundary = nowMs - Math.max(0, lookbackMs);
    let best: MildDipPriceSample | null = null;
    for (const sample of ring.samples) {
      if (
        !isAuxiliaryJupiterSource(sample.source) &&
        sample.tsMs <= boundary &&
        (!best || sample.tsMs > best.tsMs)
      ) {
        best = sample;
      }
    }
    return best;
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
   * Current drawdown: local peak → last sample, as % (negative or zero).
   * e.g. peak 100 → last 90 → −10.
   * Not a dump extent — a pump wick also prints a few % here.
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

  /**
   * Swing peak in lookback (latest max if several equal).
   */
  peakInWindow(
    mint: string,
    windowMs: number,
    nowMs = Date.now(),
  ): MildDipPriceSample | null {
    const samples = this.samplesInWindow(mint, windowMs, nowMs);
    if (samples.length === 0) return null;
    let best = samples[0]!;
    for (const s of samples) {
      if (s.priceUsd > best.priceUsd || (s.priceUsd === best.priceUsd && s.tsMs > best.tsMs)) {
        best = s;
      }
    }
    return best;
  }

  /**
   * Lowest print at/after the swing peak — the real dump trough.
   * Window-min before the peak is the base of a pump, not a dump low.
   */
  troughAfterPeak(
    mint: string,
    windowMs: number,
    nowMs = Date.now(),
  ): { peak: MildDipPriceSample; trough: MildDipPriceSample } | null {
    const samples = this.samplesInWindow(mint, windowMs, nowMs);
    if (samples.length === 0) return null;
    let peak = samples[0]!;
    for (const s of samples) {
      if (s.priceUsd > peak.priceUsd || (s.priceUsd === peak.priceUsd && s.tsMs > peak.tsMs)) {
        peak = s;
      }
    }
    let trough = peak;
    for (const s of samples) {
      if (s.tsMs < peak.tsMs) continue;
      if (s.priceUsd < trough.priceUsd) trough = s;
    }
    return { peak, trough };
  }

  /**
   * True dump extent: peak → post-peak trough, as % (≤0).
   * Pump making highs with a −2% wick → ≈−2. Still-climbing → 0.
   */
  dumpExtentFromPeakPct(
    mint: string,
    windowMs: number,
    nowMs = Date.now(),
  ): number | null {
    const pt = this.troughAfterPeak(mint, windowMs, nowMs);
    if (!pt || !(pt.peak.priceUsd > 0)) return null;
    return (pt.trough.priceUsd / pt.peak.priceUsd - 1) * 100;
  }

  /**
   * Rally into the swing peak from the pre-peak base, as % (≥0).
   * Used to reject micro-wicks after a pump (dump must cover a fraction of rally).
   */
  rallyIntoPeakPct(
    mint: string,
    windowMs: number,
    nowMs = Date.now(),
  ): number | null {
    const samples = this.samplesInWindow(mint, windowMs, nowMs);
    if (samples.length === 0) return null;
    let peak = samples[0]!;
    for (const s of samples) {
      if (s.priceUsd > peak.priceUsd || (s.priceUsd === peak.priceUsd && s.tsMs > peak.tsMs)) {
        peak = s;
      }
    }
    let base: MildDipPriceSample | null = null;
    for (const s of samples) {
      if (s.tsMs >= peak.tsMs) continue;
      if (!base || s.priceUsd < base.priceUsd) base = s;
    }
    if (!base || !(base.priceUsd > 0) || !(peak.priceUsd > 0)) return 0;
    return (peak.priceUsd / base.priceUsd - 1) * 100;
  }

  /** Bounce from window-min trough → fresh price, as % (≥0 when above trough). */
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

  /**
   * Bounce off the post-peak dump trough (not the pre-pump base).
   * Stream near-trough must use this — otherwise a pump off an old low
   * looks "far from trough" while a wick at the top looks "near trough".
   */
  bounceFromPostPeakTroughPct(
    mint: string,
    freshPriceUsd: number,
    windowMs: number,
    nowMs = Date.now(),
  ): number | null {
    const pt = this.troughAfterPeak(mint, windowMs, nowMs);
    if (!pt || !(pt.trough.priceUsd > 0) || !(freshPriceUsd > 0)) return null;
    return (freshPriceUsd / pt.trough.priceUsd - 1) * 100;
  }

  sampleCount(mint: string, windowMs: number, nowMs = Date.now()): number {
    return this.samplesInWindow(mint, windowMs, nowMs).length;
  }

  /**
   * Own stream tape around the current minute. The current-minute return is
   * latest print versus the latest print at/before the 60s boundary. The
   * preceding return is the 60s-boundary print versus the oldest print in the
   * preceding 5m window. Both require at least 3m of stream coverage.
   */
  tapeMinuteMetrics(
    mint: string,
    nowMs = Date.now(),
    boundaryMs = 60_000,
    windowMs = 360_000,
    minCoverageMs = 180_000,
    options?: MildDipTapeMinuteOptions,
  ): MildDipTapeMinuteMetrics {
    const samples = this.samplesInWindow(mint, windowMs, nowMs, true).filter(
      (sample) => sample.source === 'stream' || isAuxiliaryJupiterSource(sample.source),
    );
    const allSamples = this.samplesInWindow(
      mint,
      Math.max(windowMs, options?.priorAnchorMaxAgeMs ?? 390_000),
      nowMs,
      true,
    );
    if (samples.length === 0) {
      if (options?.strictFreshness) {
        this.tapeMinuteFailureCounts.set(
          'tape_minute_samples_insufficient',
          (this.tapeMinuteFailureCounts.get('tape_minute_samples_insufficient') ?? 0) + 1,
        );
      }
      return {
        tapeRet1mPct: null,
        tapePrior5mPct: null,
        sampleCount: 0,
        coverageMs: null,
        latestSampleAgeMs: null,
        failureReason: 'tape_minute_samples_insufficient',
      };
    }
    const strict = options?.strictFreshness === true;
    const minRecentSamples = Math.max(1, options?.minRecentSamples ?? 3);
    const latestMaxAgeMs = Math.max(0, options?.latestMaxAgeMs ?? 15_000);
    const boundaryMinAgeMs = Math.max(0, options?.boundaryMinAgeMs ?? 50_000);
    const boundaryMaxAgeMs = Math.max(
      boundaryMinAgeMs,
      options?.boundaryMaxAgeMs ?? 75_000,
    );
    const priorAnchorMinAgeMs = Math.max(
      0,
      options?.priorAnchorMinAgeMs ?? 270_000,
    );
    const priorAnchorMaxAgeMs = Math.max(
      priorAnchorMinAgeMs,
      options?.priorAnchorMaxAgeMs ?? 390_000,
    );
    let oldest = samples[0]!;
    let latest = samples[0]!;
    let boundary: MildDipPriceSample | null = null;
    let priorAnchor: MildDipPriceSample | null = null;
    const boundaryTs = nowMs - Math.max(0, boundaryMs);
    for (const sample of samples) {
      if (sample.tsMs < oldest.tsMs) oldest = sample;
      if (sample.tsMs > latest.tsMs) latest = sample;
      if (sample.tsMs <= boundaryTs && (!boundary || sample.tsMs > boundary.tsMs)) {
        boundary = sample;
      }
    }
    if (strict) {
      boundary = null;
      priorAnchor = null;
      for (const sample of samples) {
        const ageMs = Math.max(0, nowMs - sample.tsMs);
        if (
          ageMs >= boundaryMinAgeMs &&
          ageMs <= boundaryMaxAgeMs &&
          (!boundary ||
            Math.abs(ageMs - boundaryMs) <
              Math.abs(nowMs - boundary.tsMs - boundaryMs))
        ) {
          boundary = sample;
        }
      }
      for (const sample of allSamples) {
        const ageMs = Math.max(0, nowMs - sample.tsMs);
        if (
          ageMs >= priorAnchorMinAgeMs &&
          ageMs <= priorAnchorMaxAgeMs &&
          (!priorAnchor ||
            Math.abs(ageMs - 300_000) <
              Math.abs(nowMs - priorAnchor.tsMs - 300_000))
        ) {
          priorAnchor = sample;
        }
      }
    }
    const coverageMs = Math.max(0, latest.tsMs - oldest.tsMs);
    const latestSampleAgeMs = Math.max(0, nowMs - latest.tsMs);
    const boundaryAgeMs = boundary ? Math.max(0, nowMs - boundary.tsMs) : null;
    const recentSampleCount = samples.filter(
      (sample) => nowMs - sample.tsMs < 60_000,
    ).length;
    let failureReason: MildDipTapeMinuteFailureReason | null = null;
    if (strict && recentSampleCount < minRecentSamples) {
      failureReason = 'tape_minute_samples_insufficient';
    } else if (strict && latestSampleAgeMs > latestMaxAgeMs) {
      failureReason = 'tape_minute_latest_stale';
    } else if (strict && !boundary) {
      failureReason = 'tape_minute_boundary_missing';
    } else if (strict && !priorAnchor) {
      failureReason = 'tape_minute_prior_anchor_missing';
    } else if (!strict && coverageMs < Math.max(0, minCoverageMs)) {
      failureReason = 'tape_minute_coverage_insufficient';
    }
    if (
      !boundary ||
      (!strict && latestSampleAgeMs > Math.max(0, boundaryMs)) ||
      (boundaryAgeMs != null &&
        (!strict && boundaryAgeMs > Math.max(0, boundaryMs) + 60_000)) ||
      (!strict && coverageMs < Math.max(0, minCoverageMs)) ||
      (strict && (recentSampleCount < minRecentSamples || !priorAnchor)) ||
      !(oldest.priceUsd > 0) ||
      !(boundary.priceUsd > 0) ||
      !(latest.priceUsd > 0) ||
      (strict && latestSampleAgeMs > latestMaxAgeMs)
    ) {
      if (strict && failureReason) {
        this.tapeMinuteFailureCounts.set(
          failureReason,
          (this.tapeMinuteFailureCounts.get(failureReason) ?? 0) + 1,
        );
      }
      return {
        tapeRet1mPct: null,
        tapePrior5mPct: null,
        sampleCount: samples.length,
        coverageMs,
        latestSampleAgeMs,
        failureReason,
      };
    }
    const tapeRet1mPct = (latest.priceUsd / boundary.priceUsd - 1) * 100;
    const priorPriceUsd = strict ? priorAnchor!.priceUsd : oldest.priceUsd;
    const tapePrior5mPct = (boundary.priceUsd / priorPriceUsd - 1) * 100;
    return {
      tapeRet1mPct: strict
        ? tapeRet1mPct * 60_000 / Math.max(1, latest.tsMs - boundary.tsMs)
        : tapeRet1mPct,
      tapePrior5mPct: strict
        ? tapePrior5mPct * 300_000 / Math.max(1, boundary.tsMs - priorAnchor!.tsMs)
        : tapePrior5mPct,
      sampleCount: samples.length,
      coverageMs,
      latestSampleAgeMs,
      failureReason: null,
    };
  }

  streamWindowMetrics(
    mint: string,
    windowMs: number,
    nowMs = Date.now(),
  ): MildDipStreamWindowMetrics {
    const samples = this.samplesInWindow(mint, windowMs, nowMs).filter(
      (sample) => sample.source === 'stream',
    );
    if (samples.length === 0) {
      return {
        freshPriceUsd: null,
        bounceFromTroughPct: null,
        rallyIntoPeakPct: null,
        dumpExtentFromPeakPct: null,
        sampleCount: 0,
        oldestSampleAgeMs: null,
      };
    }

    let fresh = samples[0]!;
    let trough = samples[0]!;
    let peak = samples[0]!;
    for (const sample of samples) {
      if (sample.tsMs > fresh.tsMs) fresh = sample;
      if (sample.priceUsd < trough.priceUsd) trough = sample;
      if (
        sample.priceUsd > peak.priceUsd ||
        (sample.priceUsd === peak.priceUsd && sample.tsMs > peak.tsMs)
      ) {
        peak = sample;
      }
    }

    let postPeakTrough = peak;
    let prePeakBase: MildDipPriceSample | null = null;
    for (const sample of samples) {
      if (sample.tsMs >= peak.tsMs) {
        if (sample.priceUsd < postPeakTrough.priceUsd) postPeakTrough = sample;
      } else if (!prePeakBase || sample.priceUsd < prePeakBase.priceUsd) {
        prePeakBase = sample;
      }
    }

    const freshPriceUsd = fresh.priceUsd;
    return {
      freshPriceUsd,
      bounceFromTroughPct:
        trough.priceUsd > 0 ? (freshPriceUsd / trough.priceUsd - 1) * 100 : null,
      rallyIntoPeakPct:
        prePeakBase && prePeakBase.priceUsd > 0
          ? (peak.priceUsd / prePeakBase.priceUsd - 1) * 100
          : 0,
      dumpExtentFromPeakPct:
        peak.priceUsd > 0 ? (postPeakTrough.priceUsd / peak.priceUsd - 1) * 100 : null,
      sampleCount: samples.length,
      oldestSampleAgeMs: Math.max(
        0,
        nowMs -
          samples.reduce(
            (oldest, sample) => (sample.tsMs < oldest.tsMs ? sample : oldest),
          ).tsMs,
      ),
    };
  }

  windowStats(
    mint: string,
    windowMs: number,
    nowMs = Date.now(),
  ): MildDipPriceWindowStats {
    const samples = this.samplesInWindow(mint, windowMs, nowMs);
    return this.statsForSamples(samples);
  }

  observedSpanMs(mint: string, nowMs = Date.now()): number {
    this.pruneMint(mint, nowMs);
    const ring = this.byMint.get(mint);
    const samples =
      ring?.samples.filter((sample) => !isAuxiliaryJupiterSource(sample.source)) ?? [];
    if (samples.length < 2) return 0;
    let oldest = samples[0]!;
    let newest = samples[0]!;
    for (const sample of samples) {
      if (sample.tsMs < oldest.tsMs) oldest = sample;
      if (sample.tsMs > newest.tsMs) newest = sample;
    }
    return Math.max(0, newest.tsMs - oldest.tsMs);
  }

  samplesInRange(
    mint: string,
    startMs: number,
    endMs = Date.now(),
  ): MildDipPriceWindowStats {
    this.pruneMint(mint, endMs);
    const ring = this.byMint.get(mint);
    const samples =
      ring?.samples.filter(
        (sample) =>
          !isAuxiliaryJupiterSource(sample.source) &&
          sample.tsMs >= startMs &&
          sample.tsMs <= endMs,
      ) ?? [];
    return this.statsForSamples(samples);
  }

  latestAtOrBefore(mint: string, nowMs = Date.now()): MildDipPriceSample | null {
    this.pruneMint(mint, nowMs);
    const ring = this.byMint.get(mint);
    if (!ring) return null;
    let latest: MildDipPriceSample | null = null;
    for (const sample of ring.samples) {
      if (
        !isAuxiliaryJupiterSource(sample.source) &&
        sample.tsMs <= nowMs &&
        (!latest || sample.tsMs > latest.tsMs)
      ) {
        latest = sample;
      }
    }
    return latest;
  }

  evictIdle(
    nowMs = Date.now(),
    idleMs = this.ttlMs,
    protectedMints?: ReadonlySet<string>,
  ): number {
    const cutoff = nowMs - Math.max(0, idleMs);
    let evicted = 0;
    for (const [mint, ring] of this.byMint) {
      if (protectedMints?.has(mint)) continue;
      // Green quote prints keep a mint alive (they are its minute tape) even
      // though price helpers ignore them.
      const latest = ring.samples.reduce<MildDipPriceSample | null>(
        (best, sample) => (!best || sample.tsMs > best.tsMs ? sample : best),
        null,
      );
      if (!latest || latest.tsMs < cutoff) {
        this.byMint.delete(mint);
        evicted += 1;
      }
    }
    return evicted;
  }

  watchedMints(nowMs = Date.now()): string[] {
    this.pruneAll(nowMs);
    return [...this.byMint.keys()];
  }

  private samplesInWindow(
    mint: string,
    windowMs: number,
    nowMs: number,
    includeGreenJupiter = false,
  ): MildDipPriceSample[] {
    this.pruneMint(mint, nowMs);
    const ring = this.byMint.get(mint);
    if (!ring) return [];
    const cut = nowMs - Math.max(0, windowMs);
    return ring.samples.filter(
      (s) => s.tsMs >= cut && (includeGreenJupiter || !isAuxiliaryJupiterSource(s.source)),
    );
  }

  private statsForSamples(samples: MildDipPriceSample[]): MildDipPriceWindowStats {
    if (samples.length === 0) {
      return {
        sampleCount: 0,
        firstSampleTsMs: null,
        lastSampleTsMs: null,
        spanMs: 0,
        minPriceUsd: null,
        maxPriceUsd: null,
      };
    }
    let first = samples[0]!;
    let last = samples[0]!;
    let min = samples[0]!.priceUsd;
    let max = samples[0]!.priceUsd;
    for (const sample of samples) {
      if (sample.tsMs < first.tsMs) first = sample;
      if (sample.tsMs > last.tsMs) last = sample;
      if (sample.priceUsd < min) min = sample.priceUsd;
      if (sample.priceUsd > max) max = sample.priceUsd;
    }
    return {
      sampleCount: samples.length,
      firstSampleTsMs: first.tsMs,
      lastSampleTsMs: last.tsMs,
      spanMs: Math.max(0, last.tsMs - first.tsMs),
      minPriceUsd: min,
      maxPriceUsd: max,
    };
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
        const source: MildDipPriceSource =
          s.source === 'stream'
            ? 'stream'
            : s.source === 'green_jupiter'
              ? 'green_jupiter'
              : s.source === 'leader_mirror_jupiter'
                ? 'leader_mirror_jupiter'
                : 'dex';
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

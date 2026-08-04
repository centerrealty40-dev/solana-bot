/**
 * Multi-window 5m volume health.
 *
 * DexScreener only exposes a single rolling `volume.m5` — not discrete candles.
 * We approximate adjacent 5m windows by sampling that rolling metric over time
 * (typically every ~5m) and requiring a majority of the last N samples to look
 * weak before forcing an exit. One noisy tick no longer dumps the position.
 */

export type VolumeWindowConfig = {
  /** Absolute floor USD for a single sample. **0** = no floor. */
  minVolume5mUsd: number;
  /** Drop vs entry baseline %. **0** = off. */
  dropPct: number;
  /** How many recent samples form the decision window (2–3 typical). */
  sampleWindow: number;
  /** Sell / "weak" when at least this many samples in the window are weak. */
  minWeakSamples: number;
};

export type VolumeSampleAssessment =
  | { weak: false; reason: 'ok' | 'unknown' | 'warming' }
  | { weak: true; reason: 'below_floor' | 'dropped_vs_entry' };

export type MultiWindowVolumeDecision = {
  /** True when volume looks healthy enough to keep holding / extend cap. */
  healthy: boolean;
  /** True when enough weak evidence to force exit. */
  shouldExit: boolean;
  reason:
    | 'ok'
    | 'unknown'
    | 'warming'
    | 'below_floor'
    | 'dropped_vs_entry'
    | 'majority_weak';
  /** Median of the decision window (for journals). */
  medianUsd: number | null;
  weakCount: number;
  sampleCount: number;
  /** Per-sample classification of the window (oldest → newest). */
  window: VolumeSampleAssessment[];
};

export function pushVolume5mSample(
  samples: number[] | undefined,
  usd: number,
  maxKeep = 12,
): number[] {
  if (!(usd >= 0) || !Number.isFinite(usd)) return samples ? [...samples] : [];
  const next = [...(samples ?? []), usd];
  return next.length > maxKeep ? next.slice(next.length - maxKeep) : next;
}

export function medianUsd(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const a = [...samples].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  if (a.length % 2 === 1) return a[mid]!;
  return (a[mid - 1]! + a[mid]!) / 2;
}

export function classifyVolumeSample(
  cfg: Pick<VolumeWindowConfig, 'minVolume5mUsd' | 'dropPct'>,
  input: { entryVolume5mUsd?: number | null; volume5mUsd: number | null },
): VolumeSampleAssessment {
  const vol = input.volume5mUsd;
  if (vol == null || !(vol >= 0)) return { weak: false, reason: 'unknown' };

  if (cfg.minVolume5mUsd > 0 && vol < cfg.minVolume5mUsd) {
    return { weak: true, reason: 'below_floor' };
  }

  const entry =
    input.entryVolume5mUsd != null && input.entryVolume5mUsd > 0
      ? input.entryVolume5mUsd
      : null;
  if (entry != null && cfg.dropPct > 0) {
    const floor = entry * (1 - cfg.dropPct / 100);
    if (vol + 1e-9 < floor) return { weak: true, reason: 'dropped_vs_entry' };
  }

  return { weak: false, reason: 'ok' };
}

/**
 * Decide from the last `sampleWindow` readings.
 * Until the window is full → `warming` (do not exit on drop noise).
 * Exit when `weakCount >= minWeakSamples` inside the window.
 */
export function decideMultiWindowVolume(
  cfg: VolumeWindowConfig,
  input: { entryVolume5mUsd?: number | null; samples: number[] },
): MultiWindowVolumeDecision {
  const windowSize = Math.max(1, Math.floor(cfg.sampleWindow));
  const minWeak = Math.max(1, Math.min(windowSize, Math.floor(cfg.minWeakSamples)));
  const samples = input.samples.filter((x) => Number.isFinite(x) && x >= 0);
  const slice = samples.slice(-windowSize);
  const window = slice.map((volume5mUsd) =>
    classifyVolumeSample(cfg, {
      entryVolume5mUsd: input.entryVolume5mUsd,
      volume5mUsd,
    }),
  );
  const weakCount = window.filter((w) => w.weak).length;
  const med = medianUsd(slice);

  if (slice.length === 0) {
    return {
      healthy: true,
      shouldExit: false,
      reason: 'unknown',
      medianUsd: null,
      weakCount: 0,
      sampleCount: 0,
      window,
    };
  }

  if (slice.length < windowSize) {
    // Still collecting adjacent windows — only hard-exit if *every* sample so
    // far is below the absolute floor (extreme death), else wait.
    const allBelowFloor =
      cfg.minVolume5mUsd > 0 &&
      window.length > 0 &&
      window.every((w) => w.weak && w.reason === 'below_floor');
    if (allBelowFloor && window.length >= Math.min(2, windowSize)) {
      return {
        healthy: false,
        shouldExit: true,
        reason: 'below_floor',
        medianUsd: med,
        weakCount,
        sampleCount: slice.length,
        window,
      };
    }
    return {
      healthy: weakCount === 0,
      shouldExit: false,
      reason: 'warming',
      medianUsd: med,
      weakCount,
      sampleCount: slice.length,
      window,
    };
  }

  if (weakCount >= minWeak) {
    const dominant =
      window.filter((w) => w.weak && w.reason === 'below_floor').length >=
      window.filter((w) => w.weak && w.reason === 'dropped_vs_entry').length
        ? 'below_floor'
        : 'dropped_vs_entry';
    return {
      healthy: false,
      shouldExit: true,
      reason: dominant,
      medianUsd: med,
      weakCount,
      sampleCount: slice.length,
      window,
    };
  }

  return {
    healthy: true,
    shouldExit: false,
    reason: 'ok',
    medianUsd: med,
    weakCount,
    sampleCount: slice.length,
    window,
  };
}

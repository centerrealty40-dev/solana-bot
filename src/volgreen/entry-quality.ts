/**
 * Entry quality guards (post-update cliff RCA):
 * 1) Impulse already played out — last price too far below local peak.
 * 2) Thin price tape — early path must not buy on 2–3 sparse ticks.
 */

export type PriceSample = { tsMs: number; priceUsd: number };

export type OffPeakVerdict = {
  hit: boolean;
  ddPct: number | null;
  peak: number | null;
  last: number | null;
  samples: number;
};

export type ThinTapeVerdict = {
  hit: boolean;
  samples: number;
  spanMs: number;
};

function numEnv(env: NodeJS.ProcessEnv, k: string, d: number): number {
  const v = Number(env[k]?.trim());
  return Number.isFinite(v) ? v : d;
}

export function envOn(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultOn = true,
): boolean {
  const raw = (env[key] ?? (defaultOn ? '1' : '0')).trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

/** Default: reject when last is ≥5% below max price in lookback. */
export function offPeakDdMaxPct(env: NodeJS.ProcessEnv = process.env): number {
  return numEnv(env, 'VOL_GREEN_OFF_PEAK_DD_PCT', 5);
}

export function offPeakLookbackMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(
    60_000,
    Math.floor(numEnv(env, 'VOL_GREEN_OFF_PEAK_LOOKBACK_MS', 300_000)),
  );
}

/** Early-path minimum samples in lookback (default 6). */
export function earlyMinSamples(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(3, Math.floor(numEnv(env, 'VOL_GREEN_EARLY_MIN_SAMPLES', 6)));
}

export function earlyMinSampleSpanMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(
    15_000,
    Math.floor(numEnv(env, 'VOL_GREEN_EARLY_MIN_SAMPLE_SPAN_MS', 60_000)),
  );
}

export function earlySampleLookbackMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(
    60_000,
    Math.floor(numEnv(env, 'VOL_GREEN_EARLY_SAMPLE_LOOKBACK_MS', 600_000)),
  );
}

/**
 * Drawdown of last price vs max price in lookback window.
 * ddPct = (last/peak - 1) * 100 — negative when below peak.
 */
export function measureOffPeak(
  samples: PriceSample[],
  opts?: { nowMs?: number; lookbackMs?: number },
): OffPeakVerdict {
  const nowMs = opts?.nowMs ?? Date.now();
  const lookbackMs = opts?.lookbackMs ?? 300_000;
  const cut = nowMs - lookbackMs;
  const pts = samples.filter(
    (s) => s.tsMs >= cut && s.tsMs <= nowMs + 1_000 && s.priceUsd > 0,
  );
  if (pts.length < 2) {
    return { hit: false, ddPct: null, peak: null, last: null, samples: pts.length };
  }
  let peak = -Infinity;
  for (const p of pts) peak = Math.max(peak, p.priceUsd);
  const last = pts[pts.length - 1]!.priceUsd;
  if (!(peak > 0) || !(last > 0)) {
    return { hit: false, ddPct: null, peak: null, last: null, samples: pts.length };
  }
  const ddPct = (last / peak - 1) * 100;
  return { hit: false, ddPct, peak, last, samples: pts.length };
}

/** True when drawdown is worse than -maxDdPct (e.g. maxDdPct=5 → dd < -5). */
export function isImpulsePlayedOut(
  samples: PriceSample[],
  opts?: {
    nowMs?: number;
    lookbackMs?: number;
    maxDdPct?: number;
    /** Need at least this many samples to judge (else not a hit). */
    minSamples?: number;
  },
): OffPeakVerdict {
  const maxDd = opts?.maxDdPct ?? 5;
  const minSamples = opts?.minSamples ?? 4;
  const m = measureOffPeak(samples, {
    nowMs: opts?.nowMs,
    lookbackMs: opts?.lookbackMs,
  });
  if (m.samples < minSamples || m.ddPct == null) {
    return { ...m, hit: false };
  }
  // ddPct is negative when below peak; hit when below -maxDd
  const hit = m.ddPct < -Math.abs(maxDd);
  return { ...m, hit };
}

export function measureTapeDensity(
  samples: PriceSample[],
  opts?: { nowMs?: number; lookbackMs?: number },
): ThinTapeVerdict {
  const nowMs = opts?.nowMs ?? Date.now();
  const lookbackMs = opts?.lookbackMs ?? 600_000;
  const cut = nowMs - lookbackMs;
  const pts = samples
    .filter((s) => s.tsMs >= cut && s.tsMs <= nowMs + 1_000 && s.priceUsd > 0)
    .sort((a, b) => a.tsMs - b.tsMs);
  if (pts.length === 0) {
    return { hit: true, samples: 0, spanMs: 0 };
  }
  const spanMs = pts[pts.length - 1]!.tsMs - pts[0]!.tsMs;
  return { hit: false, samples: pts.length, spanMs };
}

/** Early path: reject when too few samples or span too short. */
export function isThinEarlyTape(
  samples: PriceSample[],
  opts?: {
    nowMs?: number;
    lookbackMs?: number;
    minSamples?: number;
    minSpanMs?: number;
  },
): ThinTapeVerdict {
  const minSamples = opts?.minSamples ?? 6;
  const minSpanMs = opts?.minSpanMs ?? 60_000;
  const m = measureTapeDensity(samples, {
    nowMs: opts?.nowMs,
    lookbackMs: opts?.lookbackMs,
  });
  const hit = m.samples < minSamples || m.spanMs < minSpanMs;
  return { ...m, hit };
}

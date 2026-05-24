/**
 * Sub-minute spike/dips detection from Jupiter price samples (pure functions).
 */
import { tierRequiredMinAbsPct } from './market-spike-tier-thresholds.js';

export type JupiterPriceSample = { tsMs: number; priceUsd: number };

export type JupiterSpikeDetectResult = {
  kind: 'pump' | 'dump';
  pct: number;
  anchorPx: number;
  anchorTsMs: number;
  nowPx: number;
  nowTsMs: number;
  signalKind: 'consecutive' | 'rolling';
  rollingSpanMinutes?: number;
};

export type JupiterDipsDetectResult = {
  retraceFromPeakPct: number;
  peakTsMs: number;
  peakPx: number;
  troughTsMs: number;
  troughPx: number;
};

export type JupiterSpotDetectConfig = {
  rollingMinMinutes: number;
  rollingMaxMinutes: number;
  pumpMinPct: number;
  tieredByMcap: boolean;
  dumpTier1McapUsd: number;
  dumpTier2McapUsd: number;
  dumpTier3McapUsd: number;
  dumpTier1MinPctConsec: number;
  dumpTier2MinPctConsec: number;
  dumpTier3MinPctConsec: number;
  dumpTier1MinPctRolling: number;
  dumpTier2MinPctRolling: number;
  dumpTier3MinPctRolling: number;
  minPullbackRetracePct: number;
  minRetracePumpPct: number;
  minRetraceRetracePct: number;
  scanMinutesPullback: number;
  scanMinutesRetrace: number;
};

export function pctChange(fromPx: number, toPx: number): number {
  if (!(fromPx > 0 && toPx > 0)) return 0;
  return ((toPx - fromPx) / fromPx) * 100;
}

function sortedSamples(samples: JupiterPriceSample[]): JupiterPriceSample[] {
  return [...samples].filter((s) => s.priceUsd > 0).sort((a, b) => a.tsMs - b.tsMs);
}

function sampleNearAge(samples: JupiterPriceSample[], targetAgeMs: number, toleranceMs: number): JupiterPriceSample | null {
  if (samples.length === 0) return null;
  const now = samples[samples.length - 1]!.tsMs;
  const targetTs = now - targetAgeMs;
  let best: JupiterPriceSample | null = null;
  let bestDist = Infinity;
  for (const s of samples) {
    const d = Math.abs(s.tsMs - targetTs);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best && bestDist <= toleranceMs ? best : null;
}

function dumpThreshold(refMcap: number, signalKind: 'consecutive' | 'rolling', cfg: JupiterSpotDetectConfig): number | null {
  if (!cfg.tieredByMcap) return cfg.dumpTier3MinPctConsec;
  return tierRequiredMinAbsPct(refMcap, false, signalKind);
}

function pumpThreshold(refMcap: number, cfg: JupiterSpotDetectConfig): number {
  void refMcap;
  return cfg.pumpMinPct;
}

/**
 * Detect pump/dump vs rolling window and ~60s consecutive anchor.
 */
export function detectJupiterSpikeMove(
  samples: JupiterPriceSample[],
  refMcapUsd: number,
  cfg: JupiterSpotDetectConfig,
): JupiterSpikeDetectResult | null {
  const rows = sortedSamples(samples);
  if (rows.length < 2) return null;
  const now = rows[rows.length - 1]!;
  const nowPx = now.priceUsd;

  let best: JupiterSpikeDetectResult | null = null;

  const consecAnchor = sampleNearAge(rows, 60_000, 35_000);
  if (consecAnchor && consecAnchor.tsMs < now.tsMs) {
    const pct = pctChange(consecAnchor.priceUsd, nowPx);
    const abs = Math.abs(pct);
    const isPump = pct >= 0;
    const minAbs = isPump
      ? pumpThreshold(refMcapUsd, cfg)
      : dumpThreshold(refMcapUsd, 'consecutive', cfg);
    if (minAbs != null && abs >= minAbs) {
      best = {
        kind: isPump ? 'pump' : 'dump',
        pct,
        anchorPx: consecAnchor.priceUsd,
        anchorTsMs: consecAnchor.tsMs,
        nowPx,
        nowTsMs: now.tsMs,
        signalKind: 'consecutive',
      };
    }
  }

  const minW = Math.max(1, cfg.rollingMinMinutes);
  const maxW = Math.max(minW, cfg.rollingMaxMinutes);
  for (let w = minW; w <= maxW; w++) {
    const cutoff = now.tsMs - w * 60_000;
    const inWin = rows.filter((s) => s.tsMs >= cutoff && s.tsMs <= now.tsMs);
    if (inWin.length < 2) continue;

    for (const isPump of [true, false]) {
      let anchor: JupiterPriceSample | null = null;
      for (const s of inWin) {
        if (s.tsMs >= now.tsMs) continue;
        if (!anchor) {
          anchor = s;
          continue;
        }
        if (isPump ? s.priceUsd > anchor.priceUsd : s.priceUsd < anchor.priceUsd) anchor = s;
      }
      if (!anchor || anchor.tsMs >= now.tsMs) continue;
      const pct = pctChange(anchor.priceUsd, nowPx);
      const abs = Math.abs(pct);
      const minAbs = isPump
        ? pumpThreshold(refMcapUsd, cfg)
        : dumpThreshold(refMcapUsd, 'rolling', cfg);
      if (minAbs == null || abs < minAbs) continue;
      const candidate: JupiterSpikeDetectResult = {
        kind: isPump ? 'pump' : 'dump',
        pct,
        anchorPx: anchor.priceUsd,
        anchorTsMs: anchor.tsMs,
        nowPx,
        nowTsMs: now.tsMs,
        signalKind: 'rolling',
        rollingSpanMinutes: w,
      };
      if (!best || Math.abs(candidate.pct) > Math.abs(best.pct)) best = candidate;
    }
  }

  return best;
}

/** Local-high retrace: peak in scan window vs current price. */
export function detectJupiterLocalHighRetrace(
  samples: JupiterPriceSample[],
  minRetracePct: number,
  scanMinutes: number,
): JupiterDipsDetectResult | null {
  const rows = sortedSamples(samples);
  if (rows.length < 2) return null;
  const now = rows[rows.length - 1]!;
  const cutoff = now.tsMs - scanMinutes * 60_000;
  const inWin = rows.filter((s) => s.tsMs >= cutoff);
  if (inWin.length < 2) return null;

  let peak = inWin[0]!;
  for (const s of inWin) {
    if (s.priceUsd > peak.priceUsd) peak = s;
  }
  if (peak.tsMs >= now.tsMs) return null;
  const retracePct = ((peak.priceUsd - now.priceUsd) / peak.priceUsd) * 100;
  if (!(retracePct >= minRetracePct)) return null;

  return {
    retraceFromPeakPct: retracePct,
    peakTsMs: peak.tsMs,
    peakPx: peak.priceUsd,
    troughTsMs: now.tsMs,
    troughPx: now.priceUsd,
  };
}

/** Rise-from-valley then retrace-from-peak (retrace-alert pattern). */
export function detectJupiterRiseThenRetrace(
  samples: JupiterPriceSample[],
  minPumpPct: number,
  minRetracePct: number,
  scanMinutes: number,
): JupiterDipsDetectResult | null {
  const rows = sortedSamples(samples);
  if (rows.length < 3) return null;
  const now = rows[rows.length - 1]!;
  const cutoff = now.tsMs - scanMinutes * 60_000;
  const inWin = rows.filter((s) => s.tsMs >= cutoff);
  if (inWin.length < 3) return null;

  let valley = inWin[0]!;
  let peak = inWin[0]!;
  for (const s of inWin) {
    if (s.priceUsd > peak.priceUsd) peak = s;
  }
  for (const s of inWin) {
    if (s.tsMs >= peak.tsMs) continue;
    if (s.priceUsd < valley.priceUsd) valley = s;
  }
  if (peak.tsMs <= valley.tsMs) return null;
  const pumpPct = pctChange(valley.priceUsd, peak.priceUsd);
  if (pumpPct < minPumpPct) return null;
  const retracePct = ((peak.priceUsd - now.priceUsd) / peak.priceUsd) * 100;
  if (retracePct < minRetracePct) return null;
  if (now.tsMs <= peak.tsMs) return null;

  return {
    retraceFromPeakPct: retracePct,
    peakTsMs: peak.tsMs,
    peakPx: peak.priceUsd,
    troughTsMs: now.tsMs,
    troughPx: now.priceUsd,
  };
}

export function scaleMcap(refMcapUsd: number, refPx: number, px: number): number | null {
  if (!(refMcapUsd > 0 && refPx > 0 && px > 0)) return null;
  return refMcapUsd * (px / refPx);
}

export function loadJupiterSpotDetectConfigFromEnv(): JupiterSpotDetectConfig {
  const envNum = (name: string, fallback: number) => {
    const v = process.env[name]?.trim();
    if (!v) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const envBool = (name: string, fallback: boolean) => {
    const v = process.env[name]?.trim().toLowerCase();
    if (!v) return fallback;
    return v === '1' || v === 'true' || v === 'yes';
  };

  return {
    rollingMinMinutes: Math.max(1, Math.floor(envNum('SPIKE_ALERT_ROLLING_MINUTES', 3))),
    rollingMaxMinutes: Math.max(3, Math.floor(envNum('SPIKE_ALERT_ROLLING_MAX_MINUTES', 10))),
    pumpMinPct: envNum('SPIKE_ALERT_PUMP_MIN_PCT', 30),
    tieredByMcap: envBool('SPIKE_ALERT_TIERED_BY_MCAP', true),
    dumpTier1McapUsd: envNum('SPIKE_ALERT_DUMP_TIER1_MCAP_USD', 1_500_000),
    dumpTier2McapUsd: envNum('SPIKE_ALERT_DUMP_TIER2_MCAP_USD', 3_000_000),
    dumpTier3McapUsd: envNum('SPIKE_ALERT_DUMP_TIER3_MCAP_USD', 7_000_000),
    dumpTier1MinPctConsec: envNum('SPIKE_ALERT_DUMP_TIER1_MIN_PCT', 14),
    dumpTier2MinPctConsec: envNum('SPIKE_ALERT_DUMP_TIER2_MIN_PCT', 11),
    dumpTier3MinPctConsec: envNum('SPIKE_ALERT_DUMP_TIER3_MIN_PCT', 8),
    dumpTier1MinPctRolling: envNum('SPIKE_ALERT_DUMP_TIER1_MIN_PCT_ROLLING', 15),
    dumpTier2MinPctRolling: envNum('SPIKE_ALERT_DUMP_TIER2_MIN_PCT_ROLLING', 12),
    dumpTier3MinPctRolling: envNum('SPIKE_ALERT_DUMP_TIER3_MIN_PCT_ROLLING', 10),
    minPullbackRetracePct: envNum('PULLBACK_ALERT_MIN_RETRACE_FROM_PEAK_PCT', 10),
    minRetracePumpPct: envNum('RETRACE_ALERT_MIN_PUMP_PCT', 6),
    minRetraceRetracePct: envNum('RETRACE_ALERT_MIN_RETRACE_FROM_PEAK_PCT', 10),
    scanMinutesPullback: Math.max(15, Math.floor(envNum('PULLBACK_ALERT_SCAN_MINUTES', 90))),
    scanMinutesRetrace: Math.max(30, Math.floor(envNum('RETRACE_ALERT_SCAN_MINUTES', 120))),
  };
}

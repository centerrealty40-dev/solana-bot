/**
 * Leader-style tape gate (closer to 8zkg/7BNaxx behaviour):
 *   - real multi-minute 1m history (not 1–2 ticks)
 *   - max 1m green in last 5 bars ≥ 8%
 *   - run-up over ~25m ≥ 10%
 *   - reject absurd spikes (stitch / already-exploded / scam tip)
 * Soft latest buy-bar OK — impulse must exist in the recent window.
 */
import { buildOhlcv1mFromPriceSamples, type Ohlcv1m } from './triple-green.js';

export type LeaderTapeGates = {
  enabled: boolean;
  maxGMinPc: number;
  maxGLookbackBars: number;
  runupMinPc: number;
  runupMs: number;
  lookbackMs: number;
  minBars: number;
  /** Min raw price samples in lookback (thin ring → fake maxG). */
  minSamples: number;
  /** First→last bar must span at least this many ms. */
  minSpanMs: number;
  /** Reject if maxG exceeds this (stitch artifact / nuke candle). */
  maxGMaxPc: number;
  /** Reject if run-up exceeds this (already too extended / false ring). */
  runupMaxPc: number;
};

export type LeaderTapeVerdict = {
  pass: boolean;
  reasons: string[];
  stats?: {
    bars: number;
    samples: number;
    spanMs: number;
    maxG1m: number;
    runup25m: number;
    chg1m: number;
  };
};

function candleChgPct(b: Ohlcv1m): number {
  if (!(b.open > 0)) return 0;
  return (b.close / b.open - 1) * 100;
}

export function defaultLeaderTapeGates(
  env: NodeJS.ProcessEnv = process.env,
): LeaderTapeGates {
  const off = (env.MILD_DIP_LEADER_TAPE ?? env.VOL_GREEN_LEADER_TAPE ?? '1')
    .trim()
    .toLowerCase();
  const enabled = !(off === '0' || off === 'false' || off === 'no' || off === 'off');
  const num = (k: string, d: number): number => {
    const v = Number(env[k]?.trim());
    return Number.isFinite(v) ? v : d;
  };
  return {
    enabled,
    maxGMinPc: num('MILD_DIP_LEADER_TAPE_MAX_G_PC', 8),
    maxGLookbackBars: Math.max(2, Math.floor(num('MILD_DIP_LEADER_TAPE_MAX_G_BARS', 5))),
    runupMinPc: num('MILD_DIP_LEADER_TAPE_RUNUP_PC', 10),
    runupMs: Math.max(5 * 60_000, Math.floor(num('MILD_DIP_LEADER_TAPE_RUNUP_MS', 25 * 60_000))),
    lookbackMs: Math.max(30 * 60_000, Math.floor(num('MILD_DIP_LEADER_TAPE_LOOKBACK_MS', 40 * 60_000))),
    // Leaders trade on real 1m structure — never 1–2 ticks.
    minBars: Math.max(3, Math.floor(num('MILD_DIP_LEADER_TAPE_MIN_BARS', 4))),
    minSamples: Math.max(4, Math.floor(num('MILD_DIP_LEADER_TAPE_MIN_SAMPLES', 8))),
    minSpanMs: Math.max(60_000, Math.floor(num('MILD_DIP_LEADER_TAPE_MIN_SPAN_MS', 180_000))),
    maxGMaxPc: num('MILD_DIP_LEADER_TAPE_MAX_G_MAX_PC', 40),
    runupMaxPc: num('MILD_DIP_LEADER_TAPE_RUNUP_MAX_PC', 80),
  };
}

export function detectLeaderTape(
  samples: Array<{ tsMs: number; priceUsd: number }>,
  gates: LeaderTapeGates,
  nowMs: number = Date.now(),
): LeaderTapeVerdict {
  if (!gates.enabled) {
    return { pass: true, reasons: [] };
  }
  if (!samples.length) {
    return { pass: false, reasons: ['leader_tape_no_samples'] };
  }
  if (samples.length < gates.minSamples) {
    return {
      pass: false,
      reasons: [`leader_tape_need_samples=${samples.length}<${gates.minSamples}`],
    };
  }

  const bars = buildOhlcv1mFromPriceSamples(samples, {
    lookbackMs: gates.lookbackMs,
    nowMs,
  });
  if (bars.length < gates.minBars) {
    return {
      pass: false,
      reasons: [`leader_tape_need_bars=${bars.length}<${gates.minBars}`],
    };
  }

  const nowSec = Math.floor(nowMs / 1000);
  const upToNow = bars.filter((b) => b.ts <= nowSec);
  const use = upToNow.length >= gates.minBars ? upToNow : bars;
  const spanMs = (use[use.length - 1]!.ts - use[0]!.ts) * 1000;
  if (spanMs < gates.minSpanMs) {
    return {
      pass: false,
      reasons: [`leader_tape_span=${spanMs}<${gates.minSpanMs}`],
      stats: {
        bars: use.length,
        samples: samples.length,
        spanMs,
        maxG1m: 0,
        runup25m: 0,
        chg1m: 0,
      },
    };
  }

  const trail = use.slice(-gates.maxGLookbackBars);
  let maxG1m = -Infinity;
  for (const b of trail) {
    maxG1m = Math.max(maxG1m, candleChgPct(b));
  }
  if (!Number.isFinite(maxG1m)) maxG1m = 0;

  const runupCutSec = Math.floor((nowMs - gates.runupMs) / 1000);
  const window = use.filter((b) => b.ts >= runupCutSec);
  const runBars = window.length ? window : use.slice(-Math.min(use.length, 25));
  const last = runBars[runBars.length - 1]!;
  let minLow = Infinity;
  for (const b of runBars) {
    if (b.low > 0) minLow = Math.min(minLow, b.low);
  }
  const runup25m =
    minLow > 0 && last.close > 0 ? (last.close / minLow - 1) * 100 : 0;
  const chg1m = candleChgPct(last);

  const stats = {
    bars: use.length,
    samples: samples.length,
    spanMs,
    maxG1m: +maxG1m.toFixed(3),
    runup25m: +runup25m.toFixed(3),
    chg1m: +chg1m.toFixed(3),
  };

  const reasons: string[] = [];
  if (maxG1m < gates.maxGMinPc) {
    reasons.push(`leader_tape_maxG=${maxG1m.toFixed(1)}<${gates.maxGMinPc}`);
  }
  if (maxG1m > gates.maxGMaxPc) {
    reasons.push(`leader_tape_maxG=${maxG1m.toFixed(1)}>${gates.maxGMaxPc}`);
  }
  if (runup25m < gates.runupMinPc) {
    reasons.push(`leader_tape_runup=${runup25m.toFixed(1)}<${gates.runupMinPc}`);
  }
  if (runup25m > gates.runupMaxPc) {
    reasons.push(`leader_tape_runup=${runup25m.toFixed(1)}>${gates.runupMaxPc}`);
  }
  return { pass: reasons.length === 0, reasons, stats };
}

/**
 * Leader-style tape gate (8zkg + 7BNaxx 60h forensics):
 *   - max 1m green in last 5 bars ≥ 8%
 *   - run-up over ~25m ≥ 10%
 * Buy-bar itself may be flat/soft — impulse must exist in the recent window.
 */
import { buildOhlcv1mFromPriceSamples, type Ohlcv1m } from './triple-green.js';

export type LeaderTapeGates = {
  enabled: boolean;
  /** Min max(1m chg%) over the last N completed/open bars. */
  maxGMinPc: number;
  /** How many trailing 1m bars to scan for maxG. */
  maxGLookbackBars: number;
  /** Min (close_now / min_low_window − 1) * 100. */
  runupMinPc: number;
  /** Run-up lookback window (ms). */
  runupMs: number;
  /** Bars lookback for OHLCV build. */
  lookbackMs: number;
  /** Need at least this many 1m bars (else fail closed when enabled). */
  minBars: number;
};

export type LeaderTapeVerdict = {
  pass: boolean;
  reasons: string[];
  stats?: {
    bars: number;
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
    minBars: Math.max(2, Math.floor(num('MILD_DIP_LEADER_TAPE_MIN_BARS', 2))),
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
    maxG1m: +maxG1m.toFixed(3),
    runup25m: +runup25m.toFixed(3),
    chg1m: +chg1m.toFixed(3),
  };

  const reasons: string[] = [];
  if (maxG1m < gates.maxGMinPc) {
    reasons.push(`leader_tape_maxG=${maxG1m.toFixed(1)}<${gates.maxGMinPc}`);
  }
  if (runup25m < gates.runupMinPc) {
    reasons.push(`leader_tape_runup=${runup25m.toFixed(1)}<${gates.runupMinPc}`);
  }
  return { pass: reasons.length === 0, reasons, stats };
}

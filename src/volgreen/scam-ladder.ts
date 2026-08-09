/**
 * Detect late "scam ladder" / monotonic grind:
 * many tiny green 1m steps, no real impulse bar, almost no pullbacks,
 * already been grinding for a long time — leaders never buy these late.
 */
import { buildOhlcv1mFromPriceSamples, type Ohlcv1m } from './triple-green.js';

export type ScamLadderGates = {
  enabled: boolean;
  /** Minimum grind duration (first→last bar), minutes. */
  minAgeMin: number;
  /** Max 1m step still counted as "ladder" small green. */
  maxStepPc: number;
  /** Min cumulative % over the window. */
  minCumPc: number;
  /** If any bar ≥ this, treat as real impulse (not ladder). */
  maxBarPc: number;
  /** Min share of bars that are green (0–1). */
  minGreenShare: number;
  /** Min share of bars that are small-green (0–1). */
  minSmallGreenShare: number;
  /** Max share of bars with chg ≤ −meaningfulRedPc. */
  maxMeaningfulRedShare: number;
  meaningfulRedPc: number;
  /** Min number of 1m bars required to judge. */
  minBars: number;
  lookbackMs: number;
};

export type ScamLadderVerdict = {
  hit: boolean;
  reasons: string[];
  stats?: {
    bars: number;
    ageMin: number;
    cumPc: number;
    maxBarPc: number;
    greenShare: number;
    smallGreenShare: number;
    redShare: number;
  };
};

function candleChgPct(b: Ohlcv1m): number {
  if (!(b.open > 0)) return 0;
  return (b.close / b.open - 1) * 100;
}

export function defaultScamLadderGates(
  env: NodeJS.ProcessEnv = process.env,
): ScamLadderGates {
  const on = (env.MILD_DIP_SCAM_LADDER ?? env.VOL_GREEN_SCAM_LADDER ?? '1')
    .trim()
    .toLowerCase();
  const enabled = !(on === '0' || on === 'false' || on === 'no' || on === 'off');
  const num = (k: string, d: number) => {
    const n = Number(env[k] ?? d);
    return Number.isFinite(n) ? n : d;
  };
  return {
    enabled,
    minAgeMin: num('MILD_DIP_SCAM_LADDER_MIN_AGE_MIN', 25),
    maxStepPc: num('MILD_DIP_SCAM_LADDER_MAX_STEP_PC', 4),
    minCumPc: num('MILD_DIP_SCAM_LADDER_MIN_CUM_PC', 12),
    maxBarPc: num('MILD_DIP_SCAM_LADDER_MAX_BAR_PC', 10),
    minGreenShare: num('MILD_DIP_SCAM_LADDER_MIN_GREEN_SHARE', 0.75),
    minSmallGreenShare: num('MILD_DIP_SCAM_LADDER_MIN_SMALL_GREEN_SHARE', 0.7),
    maxMeaningfulRedShare: num('MILD_DIP_SCAM_LADDER_MAX_RED_SHARE', 0.15),
    meaningfulRedPc: num('MILD_DIP_SCAM_LADDER_RED_PC', 3),
    minBars: Math.max(8, Math.floor(num('MILD_DIP_SCAM_LADDER_MIN_BARS', 20))),
    lookbackMs: Math.max(20 * 60_000, num('MILD_DIP_SCAM_LADDER_LOOKBACK_MS', 60 * 60_000)),
  };
}

export function detectMonotonicGrind(
  samples: Array<{ tsMs: number; priceUsd: number }>,
  gates: ScamLadderGates,
  nowMs = Date.now(),
): ScamLadderVerdict {
  if (!gates.enabled) {
    return { hit: false, reasons: ['scam_ladder_disabled'] };
  }
  if (!samples || samples.length < 2) {
    return { hit: false, reasons: ['scam_ladder_insufficient_samples'] };
  }

  const bars = buildOhlcv1mFromPriceSamples(samples, {
    nowMs,
    lookbackMs: gates.lookbackMs,
  });
  if (bars.length < gates.minBars) {
    return {
      hit: false,
      reasons: [`scam_ladder_bars=${bars.length}<${gates.minBars}`],
      stats: {
        bars: bars.length,
        ageMin: 0,
        cumPc: 0,
        maxBarPc: 0,
        greenShare: 0,
        smallGreenShare: 0,
        redShare: 0,
      },
    };
  }

  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  const ageMin = Math.max(0, (last.ts - first.ts) / 60);
  const cumPc =
    first.open > 0 ? ((last.close / first.open - 1) * 100) : 0;

  let green = 0;
  let smallGreen = 0;
  let meaningfulRed = 0;
  let maxBar = 0;
  for (const b of bars) {
    const chg = candleChgPct(b);
    if (chg > maxBar) maxBar = chg;
    if (b.close > b.open) {
      green += 1;
      if (chg > 0 && chg <= gates.maxStepPc) smallGreen += 1;
    }
    if (chg <= -gates.meaningfulRedPc) meaningfulRed += 1;
  }
  const n = bars.length;
  const greenShare = green / n;
  const smallGreenShare = smallGreen / n;
  const redShare = meaningfulRed / n;

  const stats = {
    bars: n,
    ageMin: +ageMin.toFixed(1),
    cumPc: +cumPc.toFixed(1),
    maxBarPc: +maxBar.toFixed(1),
    greenShare: +greenShare.toFixed(2),
    smallGreenShare: +smallGreenShare.toFixed(2),
    redShare: +redShare.toFixed(2),
  };

  const fail: string[] = [];
  if (ageMin < gates.minAgeMin) fail.push(`age=${ageMin.toFixed(0)}m<${gates.minAgeMin}`);
  if (cumPc < gates.minCumPc) fail.push(`cum=${cumPc.toFixed(1)}<${gates.minCumPc}`);
  if (maxBar >= gates.maxBarPc) fail.push(`max1m=${maxBar.toFixed(1)}≥${gates.maxBarPc}`);
  if (greenShare < gates.minGreenShare) {
    fail.push(`green=${(greenShare * 100).toFixed(0)}%<${(gates.minGreenShare * 100).toFixed(0)}`);
  }
  if (smallGreenShare < gates.minSmallGreenShare) {
    fail.push(
      `smallGreen=${(smallGreenShare * 100).toFixed(0)}%<${(gates.minSmallGreenShare * 100).toFixed(0)}`,
    );
  }
  if (redShare > gates.maxMeaningfulRedShare) {
    fail.push(`red=${(redShare * 100).toFixed(0)}%>${(gates.maxMeaningfulRedShare * 100).toFixed(0)}`);
  }

  if (fail.length > 0) {
    return { hit: false, reasons: [`scam_ladder_not_match:${fail.join(',')}`], stats };
  }

  return {
    hit: true,
    reasons: [
      `scam_ladder:late_grind age=${ageMin.toFixed(0)}m cum=+${cumPc.toFixed(0)}% ` +
        `max1m=${maxBar.toFixed(1)}% smallGreen=${(smallGreenShare * 100).toFixed(0)}% ` +
        `red${gates.meaningfulRedPc}=${(redShare * 100).toFixed(0)}%`,
    ],
    stats,
  };
}

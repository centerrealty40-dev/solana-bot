import { describe, expect, it } from 'vitest';
import {
  defaultScamLadderGates,
  detectMonotonicGrind,
  type ScamLadderGates,
} from '../../src/volgreen/scam-ladder.js';

function ladderSamples(opts: {
  nowMs: number;
  minutes: number;
  stepPc: number;
  startPx?: number;
}): Array<{ tsMs: number; priceUsd: number }> {
  const start = opts.startPx ?? 1;
  const out: Array<{ tsMs: number; priceUsd: number }> = [];
  let px = start;
  const t0 = opts.nowMs - opts.minutes * 60_000;
  for (let i = 0; i <= opts.minutes; i++) {
    out.push({ tsMs: t0 + i * 60_000, priceUsd: px });
    // one more tick in-minute so bar isn't empty of movement before stitch
    px = px * (1 + opts.stepPc / 100);
    out.push({ tsMs: t0 + i * 60_000 + 30_000, priceUsd: px });
  }
  return out;
}

function impulseSamples(nowMs: number): Array<{ tsMs: number; priceUsd: number }> {
  // small, small, huge — not a ladder
  const t0 = nowMs - 5 * 60_000;
  return [
    { tsMs: t0, priceUsd: 1.0 },
    { tsMs: t0 + 50_000, priceUsd: 1.03 },
    { tsMs: t0 + 60_000, priceUsd: 1.03 },
    { tsMs: t0 + 110_000, priceUsd: 1.08 },
    { tsMs: t0 + 120_000, priceUsd: 1.08 },
    { tsMs: t0 + 150_000, priceUsd: 1.4 },
  ];
}

function choppySamples(nowMs: number): Array<{ tsMs: number; priceUsd: number }> {
  const out: Array<{ tsMs: number; priceUsd: number }> = [];
  let px = 1;
  const t0 = nowMs - 40 * 60_000;
  for (let i = 0; i <= 40; i++) {
    const dir = i % 3 === 0 ? -0.04 : 0.03;
    out.push({ tsMs: t0 + i * 60_000, priceUsd: px });
    px = px * (1 + dir);
    out.push({ tsMs: t0 + i * 60_000 + 20_000, priceUsd: px });
  }
  return out;
}

const gates: ScamLadderGates = {
  ...defaultScamLadderGates({ MILD_DIP_SCAM_LADDER: '1' }),
  minBars: 20,
  minAgeMin: 25,
  maxStepPc: 4,
  minCumPc: 12,
  maxBarPc: 10,
};

describe('detectMonotonicGrind', () => {
  it('flags long tiny green ladder (scam grind)', () => {
    const nowMs = 1_786_284_000_000;
    const samples = ladderSamples({ nowMs, minutes: 40, stepPc: 1.5 });
    const v = detectMonotonicGrind(samples, gates, nowMs);
    expect(v.hit).toBe(true);
    expect(v.reasons[0]).toContain('scam_ladder:late_grind');
  });

  it('does not flag real impulse (small/small/huge)', () => {
    const nowMs = 1_786_284_000_000;
    const v = detectMonotonicGrind(impulseSamples(nowMs), { ...gates, minBars: 3, minAgeMin: 3 }, nowMs);
    expect(v.hit).toBe(false);
  });

  it('does not flag choppy up/down tape', () => {
    const nowMs = 1_786_284_000_000;
    const v = detectMonotonicGrind(choppySamples(nowMs), gates, nowMs);
    expect(v.hit).toBe(false);
  });

  it('does not flag short ladder (not late yet)', () => {
    const nowMs = 1_786_284_000_000;
    const samples = ladderSamples({ nowMs, minutes: 8, stepPc: 1.5 });
    const v = detectMonotonicGrind(samples, gates, nowMs);
    expect(v.hit).toBe(false);
    expect(v.reasons.some((r) => r.includes('age=') || r.includes('bars='))).toBe(true);
  });
});

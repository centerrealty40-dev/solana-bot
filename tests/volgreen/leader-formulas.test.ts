import { describe, expect, it } from 'vitest';
import {
  detectDualLeaderTape,
  f7LeaderTapeGates,
  f8LeaderTapeGates,
} from '../../src/volgreen/leader-formulas.js';
import { detectLeaderTape } from '../../src/volgreen/leader-tape.js';

/** Classic F8 climb: multi-minute +12% bar, runup ≥10%. */
function f8Climb(nowMs: number): Array<{ tsMs: number; priceUsd: number }> {
  const samples: Array<{ tsMs: number; priceUsd: number }> = [];
  const path = [1.0, 1.01, 1.02, 1.12, 1.11, 1.115];
  for (let i = 0; i < path.length; i++) {
    const t = nowMs - (path.length - i) * 60_000;
    samples.push({ tsMs: t + 5_000, priceUsd: path[i]! });
    samples.push({ tsMs: t + 45_000, priceUsd: path[i]! });
  }
  return samples;
}

/** Milder F7-only climb: maxG ~6%, runup ~7% — fails F8 floors, passes F7. */
function f7OnlyClimb(nowMs: number): Array<{ tsMs: number; priceUsd: number }> {
  const samples: Array<{ tsMs: number; priceUsd: number }> = [];
  // 4 minutes, +6% impulse bar, cumulative runup ~7%
  const path = [1.0, 1.005, 1.065, 1.07];
  for (let i = 0; i < path.length; i++) {
    const t = nowMs - (path.length - i) * 60_000;
    samples.push({ tsMs: t + 5_000, priceUsd: path[i]! });
    samples.push({ tsMs: t + 40_000, priceUsd: path[i]! });
  }
  return samples;
}

describe('dual leader formulas F8|F7', () => {
  it('F8 profile matches classic climb as F8_8zkg', () => {
    const nowMs = 1_700_000_000_000;
    const v = detectDualLeaderTape(f8Climb(nowMs), {
      nowMs,
      ringPc5mPct: 12,
      env: { VOL_GREEN_DUAL_LEADER_FORMULAS: '1' },
    });
    expect(v.pass).toBe(true);
    expect(v.formula).toBe('F8_8zkg');
  });

  it('F7-only climb fails F8 tape but passes OR when pc5m≥2', () => {
    const nowMs = 1_700_000_000_000;
    const samples = f7OnlyClimb(nowMs);
    const f8g = f8LeaderTapeGates({
      MILD_DIP_LEADER_TAPE: '1',
      MILD_DIP_LEADER_TAPE_MAX_G_PC: '8',
      MILD_DIP_LEADER_TAPE_RUNUP_PC: '10',
      MILD_DIP_LEADER_TAPE_MIN_BARS: '4',
      MILD_DIP_LEADER_TAPE_MIN_SAMPLES: '8',
      MILD_DIP_LEADER_TAPE_MIN_SPAN_MS: '180000',
    });
    expect(detectLeaderTape(samples, f8g, nowMs).pass).toBe(false);

    const f7g = f7LeaderTapeGates({ VOL_GREEN_DUAL_LEADER_FORMULAS: '1' });
    expect(detectLeaderTape(samples, f7g, nowMs).pass).toBe(true);

    const dual = detectDualLeaderTape(samples, {
      nowMs,
      ringPc5mPct: 3.5,
      env: { VOL_GREEN_DUAL_LEADER_FORMULAS: '1' },
    });
    expect(dual.pass).toBe(true);
    expect(dual.formula).toBe('F7_7BNaxx');
  });

  it('F7 climb rejected without pc5m≥2', () => {
    const nowMs = 1_700_000_000_000;
    const dual = detectDualLeaderTape(f7OnlyClimb(nowMs), {
      nowMs,
      ringPc5mPct: 1.0,
      env: { VOL_GREEN_DUAL_LEADER_FORMULAS: '1', VOL_GREEN_EARLY_TAPE: '0' },
    });
    expect(dual.pass).toBe(false);
    expect(dual.reasons.some((r) => r.includes('F7:need_pc5m'))).toBe(true);
  });

  it('F_early accepts short ~60s climb that fails F8 span', () => {
    const nowMs = 1_700_000_000_000;
    const samples: Array<{ tsMs: number; priceUsd: number }> = [];
    // 2 minutes, +10% impulse, runup ~11% — under F8 minSpan 180s / minBars 4
    const path = [1.0, 1.1, 1.11];
    for (let i = 0; i < path.length; i++) {
      const t = nowMs - (path.length - i) * 60_000;
      samples.push({ tsMs: t + 5_000, priceUsd: path[i]! });
      samples.push({ tsMs: t + 40_000, priceUsd: path[i]! });
    }
    const dual = detectDualLeaderTape(samples, {
      nowMs,
      ringPc5mPct: 11,
      env: {
        VOL_GREEN_DUAL_LEADER_FORMULAS: '1',
        VOL_GREEN_EARLY_TAPE: '1',
        // Keep F8 strict so short climb falls through to F_early
        MILD_DIP_LEADER_TAPE_MIN_BARS: '4',
        MILD_DIP_LEADER_TAPE_MIN_SAMPLES: '8',
        MILD_DIP_LEADER_TAPE_MIN_SPAN_MS: '180000',
      },
    });
    expect(dual.pass).toBe(true);
    expect(dual.formula).toBe('F_early');
  });
});

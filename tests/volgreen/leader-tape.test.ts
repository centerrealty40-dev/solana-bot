import { describe, expect, it } from 'vitest';
import {
  defaultLeaderTapeGates,
  detectLeaderTape,
} from '../../src/volgreen/leader-tape.js';

function climbSamples(nowMs: number): Array<{ tsMs: number; priceUsd: number }> {
  const samples: Array<{ tsMs: number; priceUsd: number }> = [];
  // ~6 minutes, ≥8 samples, impulse bar ~+12%, runup ~12–15%, soft tip
  const path = [1.0, 1.01, 1.02, 1.12, 1.11, 1.115];
  for (let i = 0; i < path.length; i++) {
    const t = nowMs - (path.length - i) * 60_000;
    samples.push({ tsMs: t + 5_000, priceUsd: path[i]! });
    samples.push({ tsMs: t + 45_000, priceUsd: path[i]! });
  }
  return samples;
}

describe('detectLeaderTape', () => {
  it('passes when real multi-minute maxG/runup in band (soft tip OK)', () => {
    const nowMs = 1_700_000_000_000;
    const gates = defaultLeaderTapeGates({
      MILD_DIP_LEADER_TAPE: '1',
      MILD_DIP_LEADER_TAPE_MAX_G_PC: '8',
      MILD_DIP_LEADER_TAPE_RUNUP_PC: '10',
      MILD_DIP_LEADER_TAPE_MIN_BARS: '4',
      MILD_DIP_LEADER_TAPE_MIN_SAMPLES: '8',
      MILD_DIP_LEADER_TAPE_MIN_SPAN_MS: '180000',
      MILD_DIP_LEADER_TAPE_MAX_G_MAX_PC: '40',
      MILD_DIP_LEADER_TAPE_RUNUP_MAX_PC: '80',
    });
    const v = detectLeaderTape(climbSamples(nowMs), gates, nowMs);
    expect(v.pass).toBe(true);
    expect(v.stats!.maxG1m).toBeGreaterThanOrEqual(8);
    expect(v.stats!.runup25m).toBeGreaterThanOrEqual(10);
    expect(v.stats!.bars).toBeGreaterThanOrEqual(4);
  });

  it('rejects thin 2-tick fake impulse', () => {
    const nowMs = Date.now();
    const samples = [
      { tsMs: nowMs - 50_000, priceUsd: 1.0 },
      { tsMs: nowMs - 5_000, priceUsd: 1.2 },
    ];
    const gates = defaultLeaderTapeGates({ MILD_DIP_LEADER_TAPE: '1' });
    const v = detectLeaderTape(samples, gates, nowMs);
    expect(v.pass).toBe(false);
    expect(
      v.reasons.some(
        (r) => r.startsWith('leader_tape_need_samples') || r.startsWith('leader_tape_need_bars'),
      ),
    ).toBe(true);
  });

  it('rejects absurd maxG / runup (already exploded / stitch)', () => {
    const nowMs = Date.now();
    const samples: Array<{ tsMs: number; priceUsd: number }> = [];
    for (let i = 0; i < 6; i++) {
      const t = nowMs - (6 - i) * 60_000;
      const px = i < 5 ? 1.0 : 20.0; // insane jump
      samples.push({ tsMs: t + 1_000, priceUsd: px });
      samples.push({ tsMs: t + 40_000, priceUsd: px });
    }
    const gates = defaultLeaderTapeGates({ MILD_DIP_LEADER_TAPE: '1' });
    const v = detectLeaderTape(samples, gates, nowMs);
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('>') )).toBe(true);
  });

  it('can be disabled via env', () => {
    const gates = defaultLeaderTapeGates({ MILD_DIP_LEADER_TAPE: '0' });
    expect(gates.enabled).toBe(false);
    const v = detectLeaderTape([], gates, Date.now());
    expect(v.pass).toBe(true);
  });
});

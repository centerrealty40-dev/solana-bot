import { describe, expect, it } from 'vitest';
import {
  defaultLeaderTapeGates,
  detectLeaderTape,
} from '../../src/volgreen/leader-tape.js';

describe('detectLeaderTape', () => {
  it('passes when maxG≥8 and runup≥10 (soft latest bar OK)', () => {
    const nowMs = 1_700_000_000_000;
    const samples: Array<{ tsMs: number; priceUsd: number }> = [];
    // Build ~6 minutes: climb then soft tip
    let px = 1.0;
    for (let i = 0; i < 6; i++) {
      const t = nowMs - (6 - i) * 60_000;
      if (i === 3) px = 1.12; // +12% bar
      else if (i === 4) px = 1.11;
      else if (i === 5) px = 1.115; // soft latest
      else px = 1.0 + i * 0.01;
      samples.push({ tsMs: t + 1_000, priceUsd: px });
      samples.push({ tsMs: t + 40_000, priceUsd: px });
    }
    const gates = {
      enabled: true,
      maxGMinPc: 8,
      maxGLookbackBars: 5,
      runupMinPc: 10,
      runupMs: 25 * 60_000,
      lookbackMs: 40 * 60_000,
      minBars: 2,
    };
    const v = detectLeaderTape(samples, gates, nowMs);
    expect(v.pass).toBe(true);
    expect(v.stats!.maxG1m).toBeGreaterThanOrEqual(8);
    expect(v.stats!.runup25m).toBeGreaterThanOrEqual(10);
  });

  it('rejects flat tape without impulse', () => {
    const nowMs = Date.now();
    const samples = [
      { tsMs: nowMs - 120_000, priceUsd: 1.0 },
      { tsMs: nowMs - 90_000, priceUsd: 1.01 },
      { tsMs: nowMs - 60_000, priceUsd: 1.015 },
      { tsMs: nowMs - 30_000, priceUsd: 1.02 },
      { tsMs: nowMs - 5_000, priceUsd: 1.025 },
    ];
    const gates = defaultLeaderTapeGates({
      MILD_DIP_LEADER_TAPE: '1',
      MILD_DIP_LEADER_TAPE_MAX_G_PC: '8',
      MILD_DIP_LEADER_TAPE_RUNUP_PC: '10',
    });
    const v = detectLeaderTape(samples, gates, nowMs);
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.startsWith('leader_tape_'))).toBe(true);
  });

  it('can be disabled via env', () => {
    const gates = defaultLeaderTapeGates({ MILD_DIP_LEADER_TAPE: '0' });
    expect(gates.enabled).toBe(false);
    const v = detectLeaderTape([], gates, Date.now());
    expect(v.pass).toBe(true);
  });
});

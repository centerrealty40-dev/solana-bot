import { describe, expect, it } from 'vitest';
import {
  __resetMildDipDexLoadAlertForTests,
  evaluateMildDipDexLoad,
  maybeAlertMildDipDexLoad,
} from '../../src/milddip/dex-load.js';

const gates = {
  markPassWarnMs: 20_000,
  openWarnCount: 35,
  nullRatioWarn: 0.4,
};

describe('evaluateMildDipDexLoad', () => {
  it('ok when small book and fast mark', () => {
    const v = evaluateMildDipDexLoad(
      {
        openCount: 10,
        markPassMs: 800,
        markedOk: 10,
        markedNull: 0,
        markIntervalMs: 5_000,
        markCacheTtlMs: 5_000,
      },
      gates,
    );
    expect(v.overloaded).toBe(false);
  });

  it('flags slow mark pass', () => {
    const v = evaluateMildDipDexLoad(
      {
        openCount: 12,
        markPassMs: 25_000,
        markedOk: 12,
        markedNull: 0,
        markIntervalMs: 5_000,
        markCacheTtlMs: 5_000,
      },
      gates,
    );
    expect(v.overloaded).toBe(true);
    expect(v.reasons.some((r) => r.includes('mark_pass_slow'))).toBe(true);
  });

  it('flags high open pressure', () => {
    const v = evaluateMildDipDexLoad(
      {
        openCount: 40,
        markPassMs: 6_000,
        markedOk: 40,
        markedNull: 0,
        markIntervalMs: 5_000,
        markCacheTtlMs: 5_000,
      },
      gates,
    );
    expect(v.overloaded).toBe(true);
    expect(v.reasons.some((r) => r.includes('open_pressure'))).toBe(true);
  });

  it('flags high null ratio', () => {
    const v = evaluateMildDipDexLoad(
      {
        openCount: 10,
        markPassMs: 2_000,
        markedOk: 4,
        markedNull: 6,
        markIntervalMs: 5_000,
        markCacheTtlMs: 5_000,
      },
      gates,
    );
    expect(v.overloaded).toBe(true);
    expect(v.reasons.some((r) => r.includes('mark_null_ratio'))).toBe(true);
  });
});

describe('maybeAlertMildDipDexLoad', () => {
  it('respects cooldown and send mock', async () => {
    __resetMildDipDexLoadAlertForTests();
    let sends = 0;
    const send = async () => {
      sends += 1;
      return true;
    };
    const stats = {
      openCount: 40,
      markPassMs: 30_000,
      markedOk: 40,
      markedNull: 0,
      markIntervalMs: 5_000,
      markCacheTtlMs: 5_000,
    };
    const a = await maybeAlertMildDipDexLoad({
      stats,
      gates,
      cooldownMs: 60_000,
      enabled: true,
      nowMs: 1_000_000,
      send: send as never,
    });
    expect(a.alerted).toBe(true);
    expect(sends).toBe(1);

    const b = await maybeAlertMildDipDexLoad({
      stats,
      gates,
      cooldownMs: 60_000,
      enabled: true,
      nowMs: 1_010_000,
      send: send as never,
    });
    expect(b.overloaded).toBe(true);
    expect(b.alerted).toBe(false);
    expect(sends).toBe(1);
  });
});

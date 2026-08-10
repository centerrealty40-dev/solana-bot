import { describe, expect, it } from 'vitest';
import { evaluateRebuyLiquidityDrop } from '../../src/milddip/gates.js';

describe('evaluateRebuyLiquidityDrop', () => {
  const now = 1_000_000;
  const base = {
    lastExitAtMs: now - 60_000,
    lastExitPnlPct: -12,
    nowMs: now,
    enabled: true,
    maxAgeMs: 21_600_000,
    minDropPct: 0,
    onlyAfterLoss: true,
  };

  it('blocks when current liq is below exit liq after a loss', () => {
    const v = evaluateRebuyLiquidityDrop({
      ...base,
      currentLiquidityUsd: 8_000,
      lastExitLiquidityUsd: 12_000,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain('rebuy_liq_drop');
  });

  it('allows when liq is flat or higher', () => {
    expect(
      evaluateRebuyLiquidityDrop({
        ...base,
        currentLiquidityUsd: 12_000,
        lastExitLiquidityUsd: 12_000,
      }).pass,
    ).toBe(true);
    expect(
      evaluateRebuyLiquidityDrop({
        ...base,
        currentLiquidityUsd: 15_000,
        lastExitLiquidityUsd: 12_000,
      }).pass,
    ).toBe(true);
  });

  it('fail-open when exit or current liq missing', () => {
    expect(
      evaluateRebuyLiquidityDrop({
        ...base,
        currentLiquidityUsd: 8_000,
        lastExitLiquidityUsd: null,
      }).pass,
    ).toBe(true);
    expect(
      evaluateRebuyLiquidityDrop({
        ...base,
        currentLiquidityUsd: null,
        lastExitLiquidityUsd: 12_000,
      }).pass,
    ).toBe(true);
  });

  it('skips gate after winning exit when onlyAfterLoss', () => {
    const v = evaluateRebuyLiquidityDrop({
      ...base,
      lastExitPnlPct: 8,
      currentLiquidityUsd: 5_000,
      lastExitLiquidityUsd: 12_000,
    });
    expect(v.pass).toBe(true);
  });

  it('respects minDropPct', () => {
    const mild = evaluateRebuyLiquidityDrop({
      ...base,
      minDropPct: 20,
      currentLiquidityUsd: 11_000, // ~8% drop
      lastExitLiquidityUsd: 12_000,
    });
    expect(mild.pass).toBe(true);
    const deep = evaluateRebuyLiquidityDrop({
      ...base,
      minDropPct: 20,
      currentLiquidityUsd: 8_000, // ~33% drop
      lastExitLiquidityUsd: 12_000,
    });
    expect(deep.pass).toBe(false);
  });

  it('ignores stale exits past maxAge', () => {
    const v = evaluateRebuyLiquidityDrop({
      ...base,
      lastExitAtMs: now - 30_000_000,
      currentLiquidityUsd: 5_000,
      lastExitLiquidityUsd: 12_000,
    });
    expect(v.pass).toBe(true);
  });
});

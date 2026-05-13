import { describe, it, expect } from 'vitest';
import { tpGridEffective } from '../src/papertrader/executor/tp-grid-effective.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { OpenTrade } from '../src/papertrader/types.js';

/**
 * 1.11.167: tp-grid восходящий sellFraction-профиль.
 * Проверяем `sellFractionForStep(k)` — основной helper, который теперь использует
 * tracker.ts для каждой ступени TP-сетки.
 */

function cfg(overrides: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    strategyId: 'live-oscar',
    tpGridStepPnl: 0.05,
    tpGridSellFraction: 0.1,
    tpGridSellFractionByStep: [],
    tpGridFirstRungRetraceMinPnlPct: 0.03,
    tpGridMaxRungs: undefined,
    liveExitModeAbEnabled: false,
    ...overrides,
  } as unknown as PaperTraderConfig;
}

function ot(): OpenTrade {
  return {
    liveExitProfileMode: undefined,
    tpGridOverrides: undefined,
  } as unknown as OpenTrade;
}

describe('tpGridEffective — sellFractionByStep profile', () => {
  it('falls back to flat sellFraction when profile is empty', () => {
    const eff = tpGridEffective(ot(), cfg({ tpGridSellFractionByStep: [] }));
    expect(eff.sellFractionForStep(1)).toBeCloseTo(0.1);
    expect(eff.sellFractionForStep(5)).toBeCloseTo(0.1);
    expect(eff.sellFractionByStep).toEqual([]);
  });

  it('returns profile values for each step (1-based)', () => {
    const eff = tpGridEffective(
      ot(),
      cfg({ tpGridSellFractionByStep: [0.1, 0.2, 0.3, 0.3, 0.3] }),
    );
    expect(eff.sellFractionForStep(1)).toBeCloseTo(0.1);
    expect(eff.sellFractionForStep(2)).toBeCloseTo(0.2);
    expect(eff.sellFractionForStep(3)).toBeCloseTo(0.3);
    expect(eff.sellFractionForStep(4)).toBeCloseTo(0.3);
    expect(eff.sellFractionForStep(5)).toBeCloseTo(0.3);
  });

  it('clamps step index < 1 to 1', () => {
    const eff = tpGridEffective(
      ot(),
      cfg({ tpGridSellFractionByStep: [0.1, 0.2, 0.3] }),
    );
    expect(eff.sellFractionForStep(0)).toBeCloseTo(0.1);
    expect(eff.sellFractionForStep(-5)).toBeCloseTo(0.1);
  });

  it('repeats last value for steps beyond profile length (infinite ladder tail)', () => {
    const eff = tpGridEffective(
      ot(),
      cfg({ tpGridSellFractionByStep: [0.1, 0.2, 0.3, 0.3, 0.3] }),
    );
    expect(eff.sellFractionForStep(6)).toBeCloseTo(0.3);
    expect(eff.sellFractionForStep(20)).toBeCloseTo(0.3);
    expect(eff.sellFractionForStep(100)).toBeCloseTo(0.3);
  });

  it('clamps profile values to [0..1] range', () => {
    const eff = tpGridEffective(
      ot(),
      cfg({ tpGridSellFractionByStep: [-0.1, 0.5, 1.5, 0.7] }),
    );
    expect(eff.sellFractionForStep(1)).toBe(0);
    expect(eff.sellFractionForStep(2)).toBeCloseTo(0.5);
    expect(eff.sellFractionForStep(3)).toBe(1);
    expect(eff.sellFractionForStep(4)).toBeCloseTo(0.7);
  });

  it('per-open override `gridSellFractionByStep` takes precedence over global', () => {
    const open = {
      tpGridOverrides: { gridSellFractionByStep: [0.5, 0.5] },
    } as unknown as OpenTrade;
    const eff = tpGridEffective(
      open,
      cfg({ tpGridSellFractionByStep: [0.1, 0.2, 0.3] }),
    );
    expect(eff.sellFractionForStep(1)).toBeCloseTo(0.5);
    expect(eff.sellFractionForStep(2)).toBeCloseTo(0.5);
    expect(eff.sellFractionForStep(3)).toBeCloseTo(0.5);
  });
});

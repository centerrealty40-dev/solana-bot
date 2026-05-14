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

  /**
   * 1.11.168: aggressive scalp profile. Накопленные доли проданной позиции
   * после каждой ступени. Это критично — мы хотим к ступени 5 продать ~97%
   * и оставить только 2.8% хвоста для TRAIL (закрывает leakage 1.11.167).
   */
  it('aggressive 1.11.168 profile [0.10, 0.30, 0.50, 0.70, 0.70]: cumulative position sold', () => {
    const eff = tpGridEffective(
      ot(),
      cfg({ tpGridSellFractionByStep: [0.1, 0.3, 0.5, 0.7, 0.7] }),
    );
    let remain = 1.0;
    const cumulative: number[] = [];
    for (let k = 1; k <= 5; k++) {
      const f = eff.sellFractionForStep(k);
      remain *= 1 - f;
      cumulative.push(1 - remain);
    }
    expect(cumulative[0]).toBeCloseTo(0.1, 3); // step 1: 10%
    expect(cumulative[1]).toBeCloseTo(0.37, 3); // step 2: 37%
    expect(cumulative[2]).toBeCloseTo(0.685, 3); // step 3: 68.5%
    expect(cumulative[3]).toBeCloseTo(0.9055, 3); // step 4: 90.55%
    expect(cumulative[4]).toBeCloseTo(0.97165, 3); // step 5: 97.165%
    expect(remain).toBeLessThan(0.029); // tail < 2.9%
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

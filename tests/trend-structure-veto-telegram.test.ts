import { describe, it, expect } from 'vitest';
import {
  buildTrendStructureVetoTelegramText,
  isOnlyTrendVetoReasons,
  shouldNotifyTrendStructureVeto,
} from '../src/papertrader/discovery/trend-structure-veto-telegram.js';
import type { EvalDecision } from '../src/papertrader/discovery/dip-clones.js';

function decision(over: Partial<EvalDecision> = {}): EvalDecision {
  return {
    lane: 'post_migration',
    source: 'snapshot',
    mint: 'Mint111',
    symbol: 'TEST',
    ageMin: 120,
    pass: false,
    reasons: ['trend_veto_ski_slope_pxVs14d=23.0%<42%_sinceHigh=3.8d'],
    features: {
      price_usd: 0.001,
      market_cap_usd: 500_000,
      dip_pct: -14,
      dip_lookback_min: 60,
      trend_structure_veto: {
        enabled: true,
        coverageOk: true,
        lookbackDays: 14,
        highLookbackUsd: 0.004,
        daysSinceHighBreak: 3.8,
        price7dAgoUsd: 0.002,
        price3dAgoUsd: 0.0015,
        slope7dPct: -35,
        slope3dPct: -12,
        pxVsHighLookback: 0.23,
        pgSnapsCount: 100,
        vetoed: true,
        veto_reasons: ['trend_veto_ski_slope_pxVs14d=23.0%<42%_sinceHigh=3.8d'],
        thresholds: { minDaysSinceHighBreak: 3, maxPxVsHighLookback: 0.55, maxSlope7dPct: -3 },
      },
    },
    whale: null,
    ...over,
  } as EvalDecision;
}

describe('trend-structure-veto-telegram', () => {
  it('isOnlyTrendVetoReasons accepts sole trend veto blockers', () => {
    expect(isOnlyTrendVetoReasons(['trend_veto_decline_pxVs14d=50%'])).toBe(true);
    expect(isOnlyTrendVetoReasons(['trend_veto_decline_pxVs14d=50%', 'dip_too_shallow'])).toBe(false);
  });

  it('shouldNotify when vetoed and sole blocker', () => {
    expect(shouldNotifyTrendStructureVeto(decision())).toBe(true);
    expect(shouldNotifyTrendStructureVeto(decision({ pass: true }))).toBe(false);
    expect(
      shouldNotifyTrendStructureVeto(
        decision({ reasons: ['trend_veto_ski_slope', 'runner_vol1h<80000'] }),
      ),
    ).toBe(false);
  });

  it('builds Russian telegram text with key metrics', () => {
    const text = buildTrendStructureVetoTelegramText({
      d: decision(),
      escapeHtml: (s) => s,
      mintHrefHtml: (m) => m,
      fmtUsd: (n) => `$${n}`,
    });
    expect(text).toContain('trend veto');
    expect(text).toContain('готов к покупке');
    expect(text).toContain('23.0%');
    expect(text).toContain('3.8');
  });
});

import { describe, it, expect } from 'vitest';
import {
  evaluateTrendStructureVeto,
  skiSlopeReversalBypassActive,
} from '../src/papertrader/discovery/trend-structure-veto.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function cfg(overrides: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    trendStructureVetoEnabled: true,
    trendVetoLookbackDays: 14,
    trendVetoMinPgSamples: 10,
    trendVetoNoHighBreakEnabled: true,
    trendVetoMinDaysSinceHighBreak: 3,
    trendVetoDeclineEnabled: true,
    trendVetoMaxPxVsHigh14d: 0.55,
    trendVetoMaxSlope7dPct: -3,
    trendVetoSlope3dEnabled: true,
    trendVetoMaxPxVsHigh3d: 0.65,
    trendVetoMaxSlope3dPct: -5,
    trendVetoSkiSlopeEnabled: true,
    trendVetoSkiSlopeMaxPxVsHigh: 0.42,
    trendVetoSkiSlopeMinDaysSinceHigh: 2,
    trendVetoSkiSlopeReversalBypassEnabled: true,
    trendVetoSkiSlopeReversalLookbackHours: 72,
    trendVetoSkiSlopeReversalMinBouncePct: 80,
    trendVetoSkiSlopeReversalMinHoursAfterLow: 12,
    trendVetoPeakTouchTolerancePct: 1,
    trendVetoDipBypassEnabled: true,
    trendVetoDipBypassMinDipPct: 15,
    trendVetoDipBypassMinSlope3dPct: 0,
    ...overrides,
  } as PaperTraderConfig;
}

function row(priceUsd: number): SnapshotCandidateRow {
  return { mint: 'm1', price_usd: priceUsd } as SnapshotCandidateRow;
}

const baseCtx = {
  lookbackDays: 14,
  highLookbackUsd: 1,
  daysSinceHighBreak: 2,
  price7dAgoUsd: 0.9,
  price3dAgoUsd: 0.85,
  slope7dPct: null,
  slope3dPct: null,
  pxVsHighLookback: null,
  pgSnapsCount: 100,
  coverageOk: true,
};

describe('trend-structure-veto', () => {
  it('passes when disabled', () => {
    const res = evaluateTrendStructureVeto(
      cfg({ trendStructureVetoEnabled: false }),
      row(1),
      { ...baseCtx, daysSinceHighBreak: 10 },
    );
    expect(res.reasons).toEqual([]);
  });

  it('passes when coverage insufficient', () => {
    const res = evaluateTrendStructureVeto(cfg(), row(1), {
      ...baseCtx,
      pgSnapsCount: 5,
      coverageOk: false,
    });
    expect(res.reasons).toEqual([]);
  });

  it('rule 1: no high break for 3+ days', () => {
    const res = evaluateTrendStructureVeto(cfg(), row(1), {
      ...baseCtx,
      daysSinceHighBreak: 3.1,
    });
    expect(res.reasons.some((r) => r.startsWith('trend_veto_no_high_break_'))).toBe(true);
  });

  it('rule 2: deep vs 14d high + negative 7d slope', () => {
    const res = evaluateTrendStructureVeto(cfg(), row(0.5), {
      ...baseCtx,
      daysSinceHighBreak: 1,
      price7dAgoUsd: 0.7,
    });
    expect(res.features.pxVsHighLookback).toBeCloseTo(0.5);
    expect(res.features.slope7dPct).toBeCloseTo(-28.571, 2);
    expect(res.reasons.some((r) => r.startsWith('trend_veto_decline_'))).toBe(true);
  });

  it('rule 3 ski-slope: catches expiring runner deep below peak (6Nwar-class)', () => {
    const res = evaluateTrendStructureVeto(cfg(), row(0.23), {
      ...baseCtx,
      highLookbackUsd: 1,
      daysSinceHighBreak: 3.8,
      price7dAgoUsd: 0.5,
      price3dAgoUsd: 0.35,
      localLowLookbackUsd: 0.21,
      hoursSinceLocalLow: 4,
    });
    expect(res.features.pxVsHighLookback).toBeCloseTo(0.23);
    expect(res.reasons.some((r) => r.startsWith('trend_veto_ski_slope_'))).toBe(true);
  });

  it('ski-slope bypass: post-reversal base after crash low (febu-class)', () => {
    const features = {
      ...baseCtx,
      highLookbackUsd: 0.008874,
      daysSinceHighBreak: 2.2,
      localLowLookbackUsd: 0.000703,
      hoursSinceLocalLow: 25,
    };
    expect(skiSlopeReversalBypassActive(cfg(), features, 0.002818)).toBe(true);
    const res = evaluateTrendStructureVeto(cfg(), row(0.002818), features);
    expect(res.features.pxVsHighLookback).toBeCloseTo(0.002818 / 0.008874, 3);
    expect(res.reasons.some((r) => r.startsWith('trend_veto_ski_slope_'))).toBe(false);
  });

  it('rule 2b: 3d decline path for young coins', () => {
    const res = evaluateTrendStructureVeto(cfg(), row(0.6), {
      ...baseCtx,
      daysSinceHighBreak: 1,
      price7dAgoUsd: null,
      price3dAgoUsd: 0.75,
    });
    expect(res.features.slope3dPct).toBeCloseTo(-20, 1);
    expect(res.reasons.some((r) => r.startsWith('trend_veto_decline3d_'))).toBe(true);
  });

  it('fresh runner: recent high break passes all rules', () => {
    const res = evaluateTrendStructureVeto(cfg(), row(0.95), {
      ...baseCtx,
      daysSinceHighBreak: 1,
      price7dAgoUsd: 0.8,
      price3dAgoUsd: 0.9,
    });
    expect(res.reasons).toEqual([]);
  });

  it('dip bypass: febu-class deep dip + slope3d up skips no_high_break', () => {
    const res = evaluateTrendStructureVeto(
      cfg(),
      row(0.00341),
      {
        ...baseCtx,
        highLookbackUsd: 0.008874,
        daysSinceHighBreak: 3.4,
        price7dAgoUsd: 0.0034,
        price3dAgoUsd: 0.00304,
      },
      { dipPct: -24.42 },
    );
    expect(res.features.slope3dPct).toBeGreaterThan(0);
    expect(res.reasons).toEqual([]);
  });

  it('dip bypass: ANSEM-class deep dip + slope3d up skips decline', () => {
    const res = evaluateTrendStructureVeto(
      cfg(),
      row(0.218),
      {
        ...baseCtx,
        highLookbackUsd: 0.33,
        daysSinceHighBreak: 13.3,
        price7dAgoUsd: 0.327,
        price3dAgoUsd: 0.206,
      },
      { dipPct: -19.15 },
    );
    expect(res.features.slope3dPct).toBeGreaterThan(0);
    expect(res.reasons.some((r) => r.startsWith('trend_veto_decline'))).toBe(false);
    expect(res.reasons.some((r) => r.startsWith('trend_veto_no_high_break'))).toBe(false);
  });
});

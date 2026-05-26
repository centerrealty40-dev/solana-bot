import { describe, it, expect } from 'vitest';
import { evaluateTrendStructureVeto } from '../src/papertrader/discovery/trend-structure-veto.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function cfg(overrides: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    trendStructureVetoEnabled: true,
    trendVetoLookbackDays: 14,
    trendVetoMinPgSamples: 10,
    trendVetoNoHighBreakEnabled: true,
    trendVetoMinDaysSinceHighBreak: 7,
    trendVetoDeclineEnabled: true,
    trendVetoMaxPxVsHigh14d: 0.75,
    trendVetoMaxSlope7dPct: 0,
    trendVetoPeakTouchTolerancePct: 1,
    ...overrides,
  } as PaperTraderConfig;
}

function row(priceUsd: number): SnapshotCandidateRow {
  return { mint: 'm1', price_usd: priceUsd } as SnapshotCandidateRow;
}

describe('trend-structure-veto', () => {
  it('passes when disabled', () => {
    const res = evaluateTrendStructureVeto(
      cfg({ trendStructureVetoEnabled: false }),
      row(1),
      {
        lookbackDays: 14,
        highLookbackUsd: 2,
        daysSinceHighBreak: 10,
        price7dAgoUsd: 1.5,
        slope7dPct: null,
        pxVsHighLookback: null,
        pgSnapsCount: 100,
        coverageOk: true,
      },
    );
    expect(res.reasons).toEqual([]);
  });

  it('passes when coverage insufficient', () => {
    const res = evaluateTrendStructureVeto(cfg(), row(1), {
      lookbackDays: 14,
      highLookbackUsd: 2,
      daysSinceHighBreak: 10,
      price7dAgoUsd: 1.5,
      slope7dPct: null,
      pxVsHighLookback: null,
      pgSnapsCount: 5,
      coverageOk: false,
    });
    expect(res.reasons).toEqual([]);
  });

  it('rule 1: no high break for 7+ days', () => {
    const res = evaluateTrendStructureVeto(cfg(), row(1), {
      lookbackDays: 14,
      highLookbackUsd: 2,
      daysSinceHighBreak: 7.2,
      price7dAgoUsd: 1.1,
      slope7dPct: null,
      pxVsHighLookback: null,
      pgSnapsCount: 100,
      coverageOk: true,
    });
    expect(res.reasons.some((r) => r.startsWith('trend_veto_no_high_break_'))).toBe(true);
  });

  it('rule 2: deep vs 14d high + negative 7d slope', () => {
    const res = evaluateTrendStructureVeto(cfg(), row(0.7), {
      lookbackDays: 14,
      highLookbackUsd: 1,
      daysSinceHighBreak: 2,
      price7dAgoUsd: 0.9,
      slope7dPct: null,
      pxVsHighLookback: null,
      pgSnapsCount: 100,
      coverageOk: true,
    });
    expect(res.features.pxVsHighLookback).toBeCloseTo(0.7);
    expect(res.features.slope7dPct).toBeCloseTo(-22.222, 2);
    expect(res.reasons.some((r) => r.startsWith('trend_veto_decline_'))).toBe(true);
  });

  it('fresh runner: recent high break passes both rules', () => {
    const res = evaluateTrendStructureVeto(cfg(), row(0.95), {
      lookbackDays: 14,
      highLookbackUsd: 1,
      daysSinceHighBreak: 1,
      price7dAgoUsd: 0.8,
      slope7dPct: null,
      pxVsHighLookback: null,
      pgSnapsCount: 100,
      coverageOk: true,
    });
    expect(res.reasons).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  evaluateTrackerFullExitDecision,
  defaultPositionEngineConfig,
} from '../src/live/position-engine/index.js';
import type { OpenTrade } from '../src/papertrader/types.js';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';

function baseOpen(overrides: Partial<OpenTrade> = {}): OpenTrade {
  const ts = Date.now();
  const price = 0.01;
  return {
    mint: 'MintPhaseEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    symbol: 'T',
    lane: 'post_migration',
    metricType: 'price',
    dex: 'pumpswap',
    entryTs: ts - 3_600_000,
    entryMcUsd: price,
    entryMetrics: {
      uniqueBuyers: 0,
      uniqueSellers: 0,
      sumBuySol: 0,
      sumSellSol: 0,
      topBuyerShare: 0,
      bcProgress: 0,
    },
    peakMcUsd: price * 1.2,
    peakPnlPct: 20,
    trailingArmed: false,
    legs: [{ ts, price, marketPrice: price, sizeUsd: 300, reason: 'open' }],
    partialSells: [],
    totalInvestedUsd: 300,
    avgEntry: price,
    avgEntryMarket: price,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress: null,
    entryLiqUsd: null,
    tokenDecimals: 6,
    entryLegSignatures: ['a'.repeat(64)],
    liveExitPolicyId: 'legacy_grid',
    ...overrides,
  };
}

const tgEff = {
  stepPnl: 0,
  sellFraction: 0.15,
  sellFractionByStep: [],
  sellFractionForStep: () => 0.15,
  maxRungs: undefined,
  firstRungRetraceMinPnlPct: 0,
};

describe('UPE Phase E — evaluateTrackerFullExitDecision', () => {
  it('classic kill at killEff threshold', () => {
    const cfg = loadPaperTraderConfig({ strategyId: 'live_oscar' });
    const ot = baseOpen();
    const effCfg = { ...cfg, tpX: 2, slX: 0.5, killPct: -10 };
    const r = evaluateTrackerFullExitDecision({
      cfg,
      effCfg,
      ot,
      curMetric: 0.0085,
      xAvg: 0.85,
      pnlPctVsAvg: -15,
      ageH: 1,
      tgEff,
      killEff: -0.1,
      tpLadder: [],
      stagedEntryKillMetricUsd: 0.008,
      snapPx: 0.0085,
      pendingTpProtectiveExit: null,
      ghostExitTick: false,
      idealizedMute: false,
      isPaperOscarIdealized: false,
      chainOscarUsd: 255,
      reconcileMinUsd: 1,
      flashNowMs: Date.now(),
    });
    expect(r.exitReason).toBe('KILLSTOP');
  });

  it('TP when xAvg >= tpX', () => {
    const cfg = loadPaperTraderConfig({ strategyId: 'live_oscar' });
    const ot = baseOpen();
    const effCfg = { ...cfg, tpX: 1.5, slX: 0.5, killPct: -50 };
    const r = evaluateTrackerFullExitDecision({
      cfg,
      effCfg,
      ot,
      curMetric: 0.016,
      xAvg: 1.6,
      pnlPctVsAvg: 60,
      ageH: 1,
      tgEff,
      killEff: -0.5,
      tpLadder: [],
      stagedEntryKillMetricUsd: 0.01,
      snapPx: 0.016,
      pendingTpProtectiveExit: null,
      ghostExitTick: false,
      idealizedMute: false,
      isPaperOscarIdealized: false,
      chainOscarUsd: 480,
      reconcileMinUsd: 1,
      flashNowMs: Date.now(),
    });
    expect(r.exitReason).toBe('TP');
  });

  it('respects pendingTpProtectiveExit', () => {
    const cfg = loadPaperTraderConfig({ strategyId: 'live_oscar' });
    const ot = baseOpen();
    const r = evaluateTrackerFullExitDecision({
      cfg,
      effCfg: cfg,
      ot,
      curMetric: 0.01,
      xAvg: 1,
      pnlPctVsAvg: 0,
      ageH: 1,
      tgEff,
      killEff: -0.5,
      tpLadder: [],
      stagedEntryKillMetricUsd: 0.01,
      snapPx: 0.01,
      pendingTpProtectiveExit: 'KILLSTOP',
      ghostExitTick: false,
      idealizedMute: false,
      isPaperOscarIdealized: false,
      chainOscarUsd: 300,
      reconcileMinUsd: 1,
      flashNowMs: Date.now(),
    });
    expect(r.exitReason).toBe('KILLSTOP');
  });

  it('exports defaultPositionEngineConfig for smoke', () => {
    expect(defaultPositionEngineConfig().enabled).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import { buildLiveStagedEntryState } from '../src/papertrader/executor/live-staged-entry-gates.js';
import { resolveLiveOscarStagedAvgFirstDropPct } from '../src/papertrader/live-oscar-entry-sizing.js';
import {
  reconcileE2OpenOnRestore,
  reconcileE2StagedAvgThreshold,
  replayDip10ArmingFromPriceSeries,
  tryBackfillDip10FromOpenTradeState,
} from '../src/papertrader/executor/live-oscar-e2-open-reconcile.js';
import {
  waveBDip10FirstTp5PartialEligible,
  waveBDip10FirstTp5ScenarioActive,
} from '../src/papertrader/executor/exit-policy-wave-b.js';
import { restoreOpenTradeFromJson } from '../src/papertrader/executor/store-restore.js';
import type { OpenTrade } from '../src/papertrader/types.js';

function half8Open(overrides: Partial<OpenTrade> = {}): OpenTrade {
  return {
    mint: 'mint111111111111111111111111111111111111',
    symbol: 'TEST',
    lane: 'post_migration',
    metricType: 'price',
    dex: 'raydium',
    entryTs: Date.now() - 3_600_000,
    entryMcUsd: 1,
    entryMarketCapUsd: 5_000_000,
    entryMetrics: {
      uniqueBuyers: 0,
      uniqueSellers: 0,
      sumBuySol: 0,
      sumSellSol: 0,
      topBuyerShare: 0,
      bcProgress: 0,
    },
    peakMcUsd: 1,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [{ ts: Date.now() - 3_600_000, price: 1, marketPrice: 1, sizeUsd: 300, reason: 'open' }],
    partialSells: [],
    totalInvestedUsd: 300,
    avgEntry: 1,
    avgEntryMarket: 1,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress: null,
    entryLiqUsd: null,
    liveExitPolicyId: 'wave_b_v1',
    liveWaveFlatTpMode: 'half8_runner',
    liveWavePeakPnlFrac: 0,
    liveStagedEntry: buildLiveStagedEntryState(
      loadPaperTraderConfig(),
      { signalTs: Date.now() - 3_600_000, signalPriceUsd: 1 },
      { marketCapUsd: 5_000_000 },
    ),
    ...overrides,
  } as OpenTrade;
}

describe('live-oscar E+2 open reconcile', () => {
  const envBackup: Record<string, string | undefined> = {};
  let cfg: ReturnType<typeof loadPaperTraderConfig>;

  beforeEach(() => {
    envBackup.PAPER_STRATEGY_ID = process.env.PAPER_STRATEGY_ID;
    envBackup.PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_ENABLED = process.env.PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_ENABLED;
    envBackup.PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT = process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT;
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_ENABLED = '1';
    process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT = '10';
    cfg = loadPaperTraderConfig();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('replayDip10ArmingFromPriceSeries arms when −10% precedes +8%', () => {
    const armed = replayDip10ArmingFromPriceSeries({
      signalPx: 1,
      avgEntry: 1,
      signalDropThresholdPct: 10,
      points: [
        { ts: 1, minPx: 0.95, maxPx: 0.96 },
        { ts: 2, minPx: 0.88, maxPx: 0.9 },
        { ts: 3, minPx: 0.92, maxPx: 1.04 },
      ],
    });
    expect(armed).toBe(true);
  });

  it('replayDip10ArmingFromPriceSeries skips when +8% vs avg came first', () => {
    const armed = replayDip10ArmingFromPriceSeries({
      signalPx: 1,
      avgEntry: 1,
      signalDropThresholdPct: 10,
      points: [
        { ts: 1, minPx: 1.0, maxPx: 1.09 },
        { ts: 2, minPx: 0.85, maxPx: 0.87 },
      ],
    });
    expect(armed).toBe(false);
  });

  it('pre-deploy open: historical −10% backfill → TP2 eligible at +5%', () => {
    const ot = half8Open({
      legs: [
        {
          ts: Date.now() - 3_600_000,
          price: 1,
          marketPrice: 1,
          sizeUsd: 300,
          reason: 'open',
        },
        {
          ts: Date.now() - 1_800_000,
          price: 0.88,
          marketPrice: 0.88,
          sizeUsd: 400,
          reason: 'staged_avg',
          triggerPct: -0.1,
        },
      ],
    });
    ot.liveStagedEntry!.avgFirstLegDone = true;
    ot.avgEntry = 0.93;
    ot.avgEntryMarket = 0.93;

    expect(tryBackfillDip10FromOpenTradeState(ot, cfg)).toBe(true);
    expect(waveBDip10FirstTp5ScenarioActive(ot)).toBe(true);
    expect(waveBDip10FirstTp5PartialEligible(ot, cfg, 0.05)).toBe(true);
    expect(waveBDip10FirstTp5PartialEligible(ot, cfg, 0.04)).toBe(false);
  });

  it('reconcileE2StagedAvgThreshold retargets pending avg1 from −5% to −10%', () => {
    const ot = half8Open();
    const st = ot.liveStagedEntry!;
    st.avgSecondDropPct = 5;
    st.secondDropPct = 5;
    st.avgFirstLegDone = false;

    expect(reconcileE2StagedAvgThreshold(ot, cfg)).toBe(true);
    const canonicalDrop = resolveLiveOscarStagedAvgFirstDropPct(cfg, 'prod');
    expect(st.avgSecondDropPct).toBe(canonicalDrop);
    expect(st.secondDropPct).toBe(canonicalDrop);
  });

  it('reconcileE2StagedAvgThreshold does not retarget when avg1 already filled', () => {
    const ot = half8Open({
      legs: [
        { ts: 1, price: 1, marketPrice: 1, sizeUsd: 300, reason: 'open' },
        { ts: 2, price: 0.95, marketPrice: 0.95, sizeUsd: 400, reason: 'staged_avg', triggerPct: -0.05 },
      ],
    });
    const st = ot.liveStagedEntry!;
    st.avgSecondDropPct = 5;
    st.secondDropPct = 5;

    expect(reconcileE2StagedAvgThreshold(ot, cfg)).toBe(false);
    expect(st.avgFirstLegDone).toBe(true);
  });

  it('restoreOpenTradeFromJson persists dip10 flags and reconcile on live-oscar', () => {
      const raw = {
        mint: 'mint222222222222222222222222222222222222',
        symbol: 'RST',
        entryTs: Date.now() - 60_000,
        entryMcUsd: 1,
        avgEntry: 1,
        avgEntryMarket: 1,
        remainingFraction: 1,
        legs: [{ ts: Date.now() - 60_000, price: 1, marketPrice: 1, sizeUsd: 300, reason: 'open' }],
        partialSells: [],
        totalInvestedUsd: 300,
        dcaUsedLevels: [],
        dcaUsedIndices: [],
        ladderUsedLevels: [],
        ladderUsedIndices: [],
        liveExitPolicyId: 'wave_b_v1',
        liveWaveFlatTpMode: 'half8_runner',
        liveWaveDip10ReachedBeforeTp8: true,
        liveWaveDip10FirstTp5PartialTaken: false,
        liveE2Dip10BackfillAttempted: true,
        liveStagedEntry: buildLiveStagedEntryState(
          cfg,
          { signalTs: Date.now() - 60_000, signalPriceUsd: 1 },
          { marketCapUsd: 5_000_000 },
        ),
      };
      const ot = restoreOpenTradeFromJson(raw as never);
      expect(ot?.liveWaveDip10ReachedBeforeTp8).toBe(true);
      expect(ot?.liveE2Dip10BackfillAttempted).toBe(true);
  });

  it('reconcileE2OpenOnRestore backfills dip10 from leg marks on reload', () => {
    const ot = half8Open({
      legs: [
        { ts: 1, price: 1, marketPrice: 1, sizeUsd: 300, reason: 'open' },
        { ts: 2, price: 0.87, marketPrice: 0.87, sizeUsd: 400, reason: 'entry_split' },
      ],
      lastObservedPriceUsd: 0.89,
    });
    expect(reconcileE2OpenOnRestore(ot, cfg)).toBe(true);
    expect(ot.liveWaveDip10ReachedBeforeTp8).toBe(true);
  });
});

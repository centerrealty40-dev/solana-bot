import { describe, expect, it } from 'vitest';
import type { OpenTrade } from '../src/papertrader/types.js';
import { restoreOpenTradeFromJson } from '../src/papertrader/executor/store-restore.js';
import {
  failedTpSellProtectBelowPnlFrac,
  failedTpSellReasonSupportsPending,
  retryableFailedTpSell,
} from '../src/papertrader/executor/tracker.js';
import { serializeOpenTrade } from '../src/live/strategy-snapshot.js';

function fmqhOpenWithPending(): OpenTrade {
  return {
    mint: 'FMqh111111111111111111111111111111111111111',
    symbol: 'FMqh',
    lane: 'post_migration',
    source: 'pumpswap',
    metricType: 'price',
    dex: 'pumpswap',
    entryTs: 1_000,
    entryMcUsd: 1,
    entryMarketCapUsd: null,
    entryMetrics: {
      uniqueBuyers: 0,
      uniqueSellers: 0,
      sumBuySol: 0,
      sumSellSol: 0,
      topBuyerShare: 0,
      bcProgress: 0,
    },
    peakMcUsd: 1.08,
    peakPnlPct: 8,
    trailingArmed: false,
    legs: [{ ts: 1_000, price: 1, marketPrice: 1, sizeUsd: 500, reason: 'open' }],
    partialSells: [],
    totalInvestedUsd: 500,
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
    liveExitProfileMode: 'B',
    liveWaveFlatTpMode: 'half8_runner',
    livePendingTpSell: {
      id: 'failed_tp_fmqh',
      createdTs: 2_000,
      updatedTs: 2_000,
      retryUntilTs: 182_000,
      attempts: 1,
      sellFraction: 0.5,
      reason: 'TP_LADDER',
      ladderStepIndex: 0,
      ladderRungsTotal: 0,
      ladderPnlPct: 0.08,
      tpGrid: true,
      logLabelPct: 'TPgrid+8%',
      triggerPnlFrac: 0.08,
      protectBelowPnlFrac: Number.NEGATIVE_INFINITY,
      terminalKind: 'sim_err',
      terminalMessage: 'rpc_error: Transaction simulation failed: Custom:6001',
    },
  };
}

describe('failed TP sell retry', () => {
  it('keeps FMqh Custom:6001 TP sell pending without marking TP/trail', () => {
    expect(
      retryableFailedTpSell({
        ok: false,
        terminalKind: 'sim_err',
        terminalMessage: 'rpc_error: Transaction simulation failed: Custom:6001',
      }),
    ).toBe(true);
    expect(failedTpSellReasonSupportsPending('TP_LADDER')).toBe(true);

    const restored = restoreOpenTradeFromJson(
      serializeOpenTrade(fmqhOpenWithPending()) as Partial<OpenTrade> & { mint: string },
    );

    expect(restored?.livePendingTpSell?.id).toBe('failed_tp_fmqh');
    expect(restored?.partialSells).toHaveLength(0);
    expect(restored?.ladderUsedIndices.size).toBe(0);
    expect(restored?.liveWaveMaxExecutedTpFrac).toBeUndefined();
    expect(restored?.trailingArmed).toBe(false);
  });

  it('protects pre-arm retry below avg with a full-exit threshold', () => {
    expect(failedTpSellReasonSupportsPending('WAVE_B_PRE_ARM_NO_HALF8_PARTIAL')).toBe(true);
    expect(failedTpSellProtectBelowPnlFrac('WAVE_B_PRE_ARM_NO_HALF8_PARTIAL')).toBe(0);
  });
});

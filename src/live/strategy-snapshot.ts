/**
 * W8.0 Phase 7 — JSON-safe snapshots of Oscar positions for live JSONL replay.
 */
import type { ClosedTrade, ExitReason, OpenTrade } from '../papertrader/types.js';
import { restoreOpenTradeFromJson } from '../papertrader/executor/store-restore.js';

export function serializeOpenTrade(ot: OpenTrade): Record<string, unknown> {
  return {
    mint: ot.mint,
    symbol: ot.symbol,
    lane: ot.lane,
    source: ot.source,
    metricType: ot.metricType,
    dex: ot.dex,
    entryTs: ot.entryTs,
    entryMcUsd: ot.entryMcUsd,
    entryMetrics: ot.entryMetrics,
    peakMcUsd: ot.peakMcUsd,
    peakPnlPct: ot.peakPnlPct,
    trailingArmed: ot.trailingArmed,
    legs: ot.legs,
    partialSells: ot.partialSells,
    totalInvestedUsd: ot.totalInvestedUsd,
    avgEntry: ot.avgEntry,
    avgEntryMarket: ot.avgEntryMarket,
    remainingFraction: ot.remainingFraction,
    dcaUsedLevels: [...ot.dcaUsedLevels],
    dcaUsedIndices: [...ot.dcaUsedIndices],
    ladderUsedLevels: [...ot.ladderUsedLevels],
    ladderUsedIndices: [...ot.ladderUsedIndices],
    pairAddress: ot.pairAddress,
    entryLiqUsd: ot.entryLiqUsd,
    dcaLastEvalDropFromFirstPct: ot.dcaLastEvalDropFromFirstPct,
    ...(typeof ot.dcaLastEvalPnlVsAvgFrac === 'number' && Number.isFinite(ot.dcaLastEvalPnlVsAvgFrac)
      ? { dcaLastEvalPnlVsAvgFrac: ot.dcaLastEvalPnlVsAvgFrac }
      : {}),
    liqWatchConsecutiveFailures: ot.liqWatchConsecutiveFailures,
    liqWatchLastLiqUsd: ot.liqWatchLastLiqUsd,
    liqWatchLastDropPct: ot.liqWatchLastDropPct,
    lastObservedPriceUsd: ot.lastObservedPriceUsd,
    tokenDecimals: ot.tokenDecimals,
    ...(ot.entryLegSignatures != null && ot.entryLegSignatures.length > 0
      ? { entryLegSignatures: [...ot.entryLegSignatures] }
      : {}),
    ...(ot.liveAnchorMode ? { liveAnchorMode: ot.liveAnchorMode } : {}),
    ...(ot.livePendingScaleIn != null ? { livePendingScaleIn: { ...ot.livePendingScaleIn } } : {}),
    ...(ot.liveStagedEntry != null ? { liveStagedEntry: { ...ot.liveStagedEntry } } : {}),
    ...(ot.liveOscarMcapTier === 'low' ||
    ot.liveOscarMcapTier === 'micro' ||
    ot.liveOscarMcapTier === 'scalp_wave'
      ? { liveOscarMcapTier: ot.liveOscarMcapTier }
      : {}),
    ...(ot.liveOscarTradeLane ? { liveOscarTradeLane: ot.liveOscarTradeLane } : {}),
    ...(ot.liveOscarPhaseEscalatedFrom
      ? { liveOscarPhaseEscalatedFrom: ot.liveOscarPhaseEscalatedFrom }
      : {}),
    ...(ot.tpRegime ? { tpRegime: ot.tpRegime } : {}),
    ...(ot.tpRegimeFeatures ? { tpRegimeFeatures: { ...ot.tpRegimeFeatures } } : {}),
    ...(ot.tpGridOverrides ? { tpGridOverrides: { ...ot.tpGridOverrides } } : {}),
    ...(ot.dynamicKillstopShadow ? { dynamicKillstopShadow: { ...ot.dynamicKillstopShadow } } : {}),
    ...(ot.liveExitProfileMode ? { liveExitProfileMode: ot.liveExitProfileMode } : {}),
    ...(typeof ot.liveKillstopBelowStreak === 'number' && ot.liveKillstopBelowStreak > 0
      ? { liveKillstopBelowStreak: ot.liveKillstopBelowStreak }
      : {}),
    ...(ot.liveBreakevenTrimDone ? { liveBreakevenTrimDone: true } : {}),
    ...(ot.liveWaveBreakevenInsuranceTaken ? { liveWaveBreakevenInsuranceTaken: true } : {}),
    ...(ot.liveWavePostTp1DeriskTaken ? { liveWavePostTp1DeriskTaken: true } : {}),
    ...(ot.liveWavePostTp1ScratchTaken ? { liveWavePostTp1ScratchTaken: true } : {}),
    ...(ot.liveWaveFlatTpMode ? { liveWaveFlatTpMode: ot.liveWaveFlatTpMode } : {}),
    ...(typeof ot.liveThinVolEntryVol5mUsd === 'number' && Number.isFinite(ot.liveThinVolEntryVol5mUsd)
      ? { liveThinVolEntryVol5mUsd: ot.liveThinVolEntryVol5mUsd }
      : {}),
    ...(typeof ot.liveThinVolStreak === 'number' && Number.isFinite(ot.liveThinVolStreak)
      ? { liveThinVolStreak: ot.liveThinVolStreak }
      : {}),
    ...(ot.liveThinVolFlushDone ? { liveThinVolFlushDone: true } : {}),
    ...(ot.liveExitPolicyId ? { liveExitPolicyId: ot.liveExitPolicyId } : {}),
    ...(typeof ot.liveWaveMaxExecutedTpFrac === 'number' &&
    Number.isFinite(ot.liveWaveMaxExecutedTpFrac)
      ? { liveWaveMaxExecutedTpFrac: ot.liveWaveMaxExecutedTpFrac }
      : {}),
    ...(ot.liveWavePreArmReached === true ? { liveWavePreArmReached: true } : {}),
    ...(ot.liveWaveImpulseBelowFirstRung === true ? { liveWaveImpulseBelowFirstRung: true } : {}),
    ...(typeof ot.liveWavePeakPnlFrac === 'number' && Number.isFinite(ot.liveWavePeakPnlFrac)
      ? { liveWavePeakPnlFrac: ot.liveWavePeakPnlFrac }
      : {}),
    ...(typeof ot.liveWaveTrailAnchorPnlFrac === 'number' &&
    Number.isFinite(ot.liveWaveTrailAnchorPnlFrac)
      ? { liveWaveTrailAnchorPnlFrac: ot.liveWaveTrailAnchorPnlFrac }
      : {}),
    ...(ot.liveWaveTrailLevelsTaken != null && ot.liveWaveTrailLevelsTaken.length > 0
      ? { liveWaveTrailLevelsTaken: [...ot.liveWaveTrailLevelsTaken] }
      : {}),
    ...(typeof ot.liveVariantARemainderPeakPnlFrac === 'number' &&
    Number.isFinite(ot.liveVariantARemainderPeakPnlFrac)
      ? { liveVariantARemainderPeakPnlFrac: ot.liveVariantARemainderPeakPnlFrac }
      : {}),
    ...(ot.liveVariantATrailArmed ? { liveVariantATrailArmed: true } : {}),
    ...(ot.liveVariantASmart48Extended ? { liveVariantASmart48Extended: true } : {}),
    ...(ot.liveVariantASalvage24Checked ? { liveVariantASalvage24Checked: true } : {}),
    ...(ot.liveVariantAH48Checked ? { liveVariantAH48Checked: true } : {}),
    ...(ot.liveMintFirstProbe ? { liveMintFirstProbe: true } : {}),
    ...(typeof ot.liveMintFirstProbeKillDropPct === 'number' &&
    Number.isFinite(ot.liveMintFirstProbeKillDropPct)
      ? { liveMintFirstProbeKillDropPct: ot.liveMintFirstProbeKillDropPct }
      : {}),
    ...(ot.presetCTgDedupeKeys != null && ot.presetCTgDedupeKeys.length > 0
      ? { presetCTgDedupeKeys: [...ot.presetCTgDedupeKeys] }
      : {}),
    ...(typeof ot.presetCScalpAnchorPriceUsd === 'number' &&
    Number.isFinite(ot.presetCScalpAnchorPriceUsd) &&
    ot.presetCScalpAnchorPriceUsd > 0
      ? { presetCScalpAnchorPriceUsd: ot.presetCScalpAnchorPriceUsd }
      : {}),
    ...(ot.presetCScalpTp25Taken ? { presetCScalpTp25Taken: true } : {}),
    ...(ot.presetCScalpTp5Taken ? { presetCScalpTp5Taken: true } : {}),
    ...(ot.presetCScalpTp10Taken ? { presetCScalpTp10Taken: true } : {}),
    ...(ot.presetCScalpTrailArmed ? { presetCScalpTrailArmed: true } : {}),
    ...(ot.presetCScalpDcaLegDone ? { presetCScalpDcaLegDone: true } : {}),
  };
}

export function serializeClosedTrade(ct: ClosedTrade): Record<string, unknown> {
  return {
    ...serializeOpenTrade(ct),
    exitTs: ct.exitTs,
    exitMcUsd: ct.exitMcUsd,
    exitReason: ct.exitReason,
    pnlPct: ct.pnlPct,
    durationMin: ct.durationMin,
    totalProceedsUsd: ct.totalProceedsUsd,
    netPnlUsd: ct.netPnlUsd,
    grossTotalProceedsUsd: ct.grossTotalProceedsUsd,
    grossPnlUsd: ct.grossPnlUsd,
    grossPnlPct: ct.grossPnlPct,
    costs: ct.costs,
    effective_entry_price: ct.effective_entry_price,
    effective_exit_price: ct.effective_exit_price,
    theoretical_entry_price: ct.theoretical_entry_price,
    theoretical_exit_price: ct.theoretical_exit_price,
    exitContext: ct.exitContext,
    ...(ct.fullExitTxSignature ? { fullExitTxSignature: ct.fullExitTxSignature } : {}),
  };
}

export function restoreClosedTradeFromJson(raw: Record<string, unknown>): ClosedTrade | null {
  const base = restoreOpenTradeFromJson(raw as Partial<OpenTrade> & { mint: string });
  if (!base) return null;
  try {
    const costs = raw.costs;
    if (typeof costs !== 'object' || costs === null) return null;
    const fullExit =
      typeof raw.fullExitTxSignature === 'string' && raw.fullExitTxSignature.length > 16
        ? raw.fullExitTxSignature
        : undefined;
    return {
      ...base,
      exitTs: Number(raw.exitTs),
      exitMcUsd: Number(raw.exitMcUsd ?? 0),
      exitReason: raw.exitReason as ExitReason,
      pnlPct: Number(raw.pnlPct ?? 0),
      durationMin: Number(raw.durationMin ?? 0),
      totalProceedsUsd: Number(raw.totalProceedsUsd ?? 0),
      netPnlUsd: Number(raw.netPnlUsd ?? 0),
      grossTotalProceedsUsd: Number(raw.grossTotalProceedsUsd ?? 0),
      grossPnlUsd: Number(raw.grossPnlUsd ?? 0),
      grossPnlPct: Number(raw.grossPnlPct ?? 0),
      costs: costs as ClosedTrade['costs'],
      effective_entry_price: Number(raw.effective_entry_price ?? base.avgEntry),
      effective_exit_price: Number(raw.effective_exit_price ?? 0),
      theoretical_entry_price: Number(raw.theoretical_entry_price ?? base.avgEntryMarket),
      theoretical_exit_price: Number(raw.theoretical_exit_price ?? 0),
      exitContext: raw.exitContext as ClosedTrade['exitContext'],
      ...(fullExit ? { fullExitTxSignature: fullExit } : {}),
    };
  } catch {
    return null;
  }
}

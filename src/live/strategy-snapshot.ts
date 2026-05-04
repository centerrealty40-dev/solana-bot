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
    ...(ot.tpRegime ? { tpRegime: ot.tpRegime } : {}),
    ...(ot.tpRegimeFeatures ? { tpRegimeFeatures: { ...ot.tpRegimeFeatures } } : {}),
    ...(ot.tpGridOverrides ? { tpGridOverrides: { ...ot.tpGridOverrides } } : {}),
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
  };
}

export function restoreClosedTradeFromJson(raw: Record<string, unknown>): ClosedTrade | null {
  const base = restoreOpenTradeFromJson(raw as Partial<OpenTrade> & { mint: string });
  if (!base) return null;
  try {
    const costs = raw.costs;
    if (typeof costs !== 'object' || costs === null) return null;
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
    };
  } catch {
    return null;
  }
}

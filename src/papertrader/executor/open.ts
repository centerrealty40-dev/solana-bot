import type { PaperTraderConfig } from '../config.js';
import type { DexId, Lane, Metrics, OpenTrade, PositionLeg, SnapshotCandidateRow } from '../types.js';
import { applyEntryCosts } from '../costs.js';
import { stampFlashKillLastBuyLeg } from './flash-crash-kill.js';
import { snapshotRefMarketCapUsd } from '../filters/snapshot-filter.js';

const EMPTY_METRICS: Metrics = {
  uniqueBuyers: 0,
  uniqueSellers: 0,
  sumBuySol: 0,
  sumSellSol: 0,
  topBuyerShare: 0,
  bcProgress: 0,
};

export interface MakeOpenArgs {
  cfg: PaperTraderConfig;
  row: SnapshotCandidateRow;
  lane: Lane;
  dex: DexId;
  liquidityUsd: number | null | undefined;
  /** W7.4 — reuse entry timestamp when rebuilding OpenTrade after Jupiter price override. */
  entryTs?: number;
  /** Overrides `positionUsd * entryFirstLegFraction` (e.g. staged entry split leg 1). */
  firstLegUsdOverride?: number;
}

export function makeOpenTradeFromEntry(args: MakeOpenArgs): OpenTrade {
  const { cfg, row, lane, dex, liquidityUsd, entryTs: fixedEntryTs, firstLegUsdOverride } = args;
  const sizeUsd =
    firstLegUsdOverride != null && firstLegUsdOverride > 0
      ? firstLegUsdOverride
      : cfg.positionUsd * cfg.entryFirstLegFraction;
  const marketPrice = Number(row.price_usd);
  const entryMarketCapUsd = (() => {
    const mc = snapshotRefMarketCapUsd(row);
    return mc > 0 ? +mc.toFixed(2) : null;
  })();
  const { effectivePrice } = applyEntryCosts(cfg, marketPrice, dex, sizeUsd, liquidityUsd ?? row.liquidity_usd);
  const ts = fixedEntryTs ?? Date.now();
  const firstLeg: PositionLeg = {
    ts,
    price: effectivePrice,
    marketPrice,
    sizeUsd,
    reason: 'open',
  };
  const ot: OpenTrade = {
    mint: row.mint,
    symbol: row.symbol,
    lane,
    source: row.source,
    metricType: 'price',
    dex,
    entryTs: ts,
    entryMcUsd: effectivePrice,
    entryMarketCapUsd,
    entryMetrics: EMPTY_METRICS,
    peakMcUsd: effectivePrice,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [firstLeg],
    partialSells: [],
    totalInvestedUsd: sizeUsd,
    avgEntry: effectivePrice,
    avgEntryMarket: marketPrice,
    remainingFraction: 1,
    dcaUsedLevels: new Set<number>(),
    dcaUsedIndices: new Set<number>(),
    ladderUsedLevels: new Set<number>(),
    ladderUsedIndices: new Set<number>(),
    pairAddress:
      row.pair_address != null && String(row.pair_address).trim() ? String(row.pair_address) : null,
    entryLiqUsd:
      typeof row.liquidity_usd === 'number' && Number(row.liquidity_usd) > 0
        ? Number(row.liquidity_usd)
        : null,
    liveThinVolEntryVol5mUsd:
      typeof row.volume_5m === 'number' && Number(row.volume_5m) > 0 ? Number(row.volume_5m) : undefined,
    entryVol1hUsd:
      typeof row.volume_1h === 'number' && Number(row.volume_1h) > 0 ? Number(row.volume_1h) : null,
  };
  stampFlashKillLastBuyLeg(ot, marketPrice, ts);
  return ot;
}

export function snapshotSourceToDex(source: string): DexId {
  switch (source) {
    case 'raydium':
      return 'raydium';
    case 'orca':
      return 'orca';
    case 'meteora':
      return 'meteora';
    case 'moonshot':
      return 'moonshot';
    case 'pumpswap':
      return 'pumpswap';
    default:
      return 'raydium';
  }
}

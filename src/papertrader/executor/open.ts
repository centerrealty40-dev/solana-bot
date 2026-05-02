import type { PaperTraderConfig } from '../config.js';
import type { DexId, Lane, Metrics, OpenTrade, PositionLeg, SnapshotCandidateRow } from '../types.js';
import { applyEntryCosts } from '../costs.js';

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
}

export function makeOpenTradeFromEntry(args: MakeOpenArgs): OpenTrade {
  const { cfg, row, lane, dex, liquidityUsd, entryTs: fixedEntryTs } = args;
  const sizeUsd = cfg.positionUsd;
  const marketPrice = Number(row.price_usd);
  const { effectivePrice } = applyEntryCosts(cfg, marketPrice, dex, sizeUsd, liquidityUsd ?? row.liquidity_usd);
  const ts = fixedEntryTs ?? Date.now();
  const firstLeg: PositionLeg = {
    ts,
    price: effectivePrice,
    marketPrice,
    sizeUsd,
    reason: 'open',
  };
  return {
    mint: row.mint,
    symbol: row.symbol,
    lane,
    source: row.source,
    metricType: 'price',
    dex,
    entryTs: ts,
    entryMcUsd: effectivePrice,
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
    ladderUsedLevels: new Set<number>(),
    pairAddress:
      row.pair_address != null && String(row.pair_address).trim() ? String(row.pair_address) : null,
    entryLiqUsd:
      typeof row.liquidity_usd === 'number' && Number(row.liquidity_usd) > 0
        ? Number(row.liquidity_usd)
        : null,
  };
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

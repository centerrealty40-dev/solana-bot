export type Lane = 'launchpad_early' | 'migration_event' | 'post_migration';
export type StrategyKind = 'fresh' | 'dip' | 'smart_lottery' | 'fresh_validated';
export type ExitReason = 'TP' | 'SL' | 'TRAIL' | 'TIMEOUT' | 'NO_DATA' | 'KILLSTOP';
export type DexId = 'pumpfun' | 'pumpswap' | 'raydium' | 'orca' | 'meteora' | 'moonshot';

export interface Metrics {
  uniqueBuyers: number;
  uniqueSellers: number;
  sumBuySol: number;
  sumSellSol: number;
  topBuyerShare: number;
  bcProgress: number;
}

export interface PositionLeg {
  ts: number;
  /** EFFECTIVE entry price (with buy costs applied) — used for TP/SL/trail vs avgEntry. */
  price: number;
  /** Raw market price at entry — kept for gross PnL / post-mortem. */
  marketPrice: number;
  /** Money we paid for this leg (paper) — reduces our paper bank. */
  sizeUsd: number;
  reason: 'open' | 'dca';
  /** For dca: trigger percentage that fired (e.g. -0.07, -0.15). */
  triggerPct?: number;
}

export interface PartialSell {
  ts: number;
  /** EFFECTIVE sell price (with sell costs applied). */
  price: number;
  marketPrice: number;
  /** Fraction of REMAINING position sold (0..1). */
  sellFraction: number;
  reason: 'TP_LADDER' | 'TRAIL' | 'TIMEOUT' | 'KILLSTOP' | 'SL';
  proceedsUsd: number;
  grossProceedsUsd: number;
  pnlUsd: number;
  grossPnlUsd: number;
}

export interface OpenTrade {
  mint: string;
  symbol: string;
  lane: Lane;
  source?: string;
  metricType: 'mc' | 'price';
  dex: DexId;
  entryTs: number;
  /** First-leg EFFECTIVE entry price (kept for back-compat). */
  entryMcUsd: number;
  entryMetrics: Metrics;
  peakMcUsd: number;
  peakPnlPct: number;
  trailingArmed: boolean;
  legs: PositionLeg[];
  partialSells: PartialSell[];
  totalInvestedUsd: number;
  /** Weighted-average EFFECTIVE entry price — used for TP/SL/trail. */
  avgEntry: number;
  /** Weighted-average MARKET entry price — used for gross PnL. */
  avgEntryMarket: number;
  remainingFraction: number;
  /** DCA levels (in pct) already triggered (-7, -15, ...). */
  dcaUsedLevels: Set<number>;
  /** TP-ladder pnl levels already used (0.05, 0.10, ...). */
  ladderUsedLevels: Set<number>;
}

export interface CloseCosts {
  dex: DexId;
  fee_bps_per_side: number;
  slip_base_bps_per_side: number;
  slip_dynamic_bps_entry: number;
  slip_dynamic_bps_exit: number;
  network_fee_usd_total: number;
  gross_pnl_usd: number;
  fee_cost_usd: number;
  slippage_cost_usd: number;
  network_cost_usd: number;
  net_pnl_usd: number;
}

export interface ClosedTrade extends OpenTrade {
  exitTs: number;
  exitMcUsd: number;
  exitReason: ExitReason;
  /** Realized NET total return % vs invested. */
  pnlPct: number;
  durationMin: number;
  totalProceedsUsd: number;
  netPnlUsd: number;
  grossTotalProceedsUsd: number;
  grossPnlUsd: number;
  grossPnlPct: number;
  costs: CloseCosts;
  /** Effective entry/exit prices (with costs). */
  effective_entry_price: number;
  effective_exit_price: number;
  /** Theoretical entry/exit prices (raw market). */
  theoretical_entry_price: number;
  theoretical_exit_price: number;
}

export type JsonlEventKind =
  | 'heartbeat'
  | 'eval'
  | 'eval-skip-open'
  | 'open'
  | 'peak'
  | 'dca_add'
  | 'partial_sell'
  | 'close'
  | 'followup_snapshot';

export interface JsonlEventBase {
  ts: number;
  strategyId: string;
  kind: JsonlEventKind;
}

export interface HeartbeatEvent extends JsonlEventBase {
  kind: 'heartbeat';
  uptimeSec: number;
  openPositions: number;
  closedTotal: number;
  solUsd: number;
  btc: { ret1h_pct: number | null; ret4h_pct: number | null; updated_ts: number | null };
  /** "no candidates" / "filters not implemented" / "discovery skipped" — диагностика. */
  note?: string;
}

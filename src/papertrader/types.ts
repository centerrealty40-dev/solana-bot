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

export interface SnapshotCandidateRow {
  mint: string;
  symbol: string;
  ts: Date | string;
  launch_ts: Date | string | null;
  age_min: number | null;
  price_usd: number;
  liquidity_usd: number;
  volume_5m: number;
  buys_5m: number;
  sells_5m: number;
  market_cap_usd: number | null;
  source: string;
  holder_count: number;
  token_age_min: number;
}

export interface DipContext {
  high_px: number;
  low_px: number;
}

export interface SnapshotFeatures {
  price_usd: number;
  liq_usd: number;
  vol5m_usd: number;
  buys5m: number;
  sells5m: number;
  buy_sell_ratio_5m: number | null;
  holders: number;
  token_age_min: number;
  dip_pct: number | null;
  impulse_pct: number | null;
}

export type SellerProfile =
  | 'capitulator'
  | 'still_dumping'
  | 'dca_predictable'
  | 'dca_aggressive'
  | 'panic_random'
  | 'unknown';

export interface WhaleSeller {
  wallet: string;
  amount_usd: number;
  pct_of_position_dumped: number;
  pct_total_dumped_now: number;
  is_creator: boolean;
  profile: SellerProfile;
  n_sells_24h: number;
  median_interval_min: number | null;
  median_chunk_usd: number | null;
}

export interface WhaleAnalysis {
  enabled: boolean;
  creator_wallet: string | null;
  creator_dumped_pct: number;
  creator_dump_block: boolean;
  large_sells: WhaleSeller[];
  single_whale_capitulation: boolean;
  group_sell_pressure: boolean;
  dca_predictable_present: boolean;
  dca_aggressive_present: boolean;
  trigger_fired: 'whale_capitulation' | 'group_pressure' | 'dca_predictable' | null;
  block_reasons: string[];
}

/** W7.2 on-chain pre-entry safety (QuickNode batch). */
export interface SafetyVerdict {
  ok: boolean;
  reasons: string[];
  mint_authority: string | null;
  freeze_authority: string | null;
  top_holder_pct: number | null;
  decimals: number | null;
  /** Raw supply (u64 as string). */
  supply: string | null;
  ts: number;
}

export interface EvalEvent extends JsonlEventBase {
  kind: 'eval';
  lane: Lane;
  source?: string;
  mint: string;
  symbol: string;
  ageMin: number;
  pass: boolean;
  reasons: string[];
  m: SnapshotFeatures;
  btc: { ret1h_pct: number | null; ret4h_pct: number | null; updated_ts: number | null };
  whale_analysis: WhaleAnalysis | null;
}

export interface EvalSkipOpenEvent extends JsonlEventBase {
  kind: 'eval-skip-open';
  lane: Lane;
  source?: string;
  mint: string;
  reason: string;
}

export interface PreEntryDynamics {
  holders_30m_ago: number;
  holders_10m_ago: number;
  holders_now: number;
  holders_delta_30_to_now: number;
  holders_delta_10_to_now: number;
  vol5m_30m_ago_usd: number;
  vol5m_10m_ago_usd: number;
  vol5m_now_usd: number;
  vol_growth_30m_pct: number | null;
  vol_growth_10m_pct: number | null;
  bs_5m_30m_ago: number | null;
  bs_5m_10m_ago: number | null;
  bs_5m_now: number | null;
  price_30m_ago: number | null;
  price_10m_ago: number | null;
  price_now: number | null;
  price_growth_30m_pct: number | null;
  price_growth_10m_pct: number | null;
  trend_holders: 'rising' | 'flat' | 'falling' | 'unknown';
  trend_volume: 'rising' | 'flat' | 'falling' | 'unknown';
  trend_price: 'rising' | 'flat' | 'falling' | 'unknown';
}

export interface PendingFollowup {
  mint: string;
  symbol: string;
  entryTs: number;
  entryPrice: number;
  entryMarketPrice: number;
  metricType: 'mc' | 'price';
  source?: string;
  offsetMin: number;
  dueTs: number;
}

export interface ContextSwap {
  ts: number;
  side: string;
  amount_usd: number;
  price_usd: number;
  wallet?: string;
}

export type Lane = 'launchpad_early' | 'migration_event' | 'post_migration';
export type StrategyKind = 'fresh' | 'dip' | 'smart_lottery' | 'fresh_validated';
export type ExitReason =
  | 'TP'
  | 'SL'
  | 'TRAIL'
  | 'TIMEOUT'
  | 'NO_DATA'
  | 'KILLSTOP'
  | 'LIQ_DRAIN'
  /** Journal replay expected tokens but boot reconcile reported wallet raw balance 0 (live). */
  | 'RECONCILE_ORPHAN'
  /** Live periodic job: force full exit + chain-sized sell, skipping exit price-verify defer loop. */
  | 'PERIODIC_HEAL';
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
  /** DCA drawdown levels (as fraction) already used — legacy; use with epsilon match and `dcaUsedIndices`. */
  dcaUsedLevels: Set<number>;
  /** Indices into sorted `PAPER_DCA_LEVELS` (canonical, prevents double-fills). */
  dcaUsedIndices: Set<number>;
  /**
   * Last tick's drawdown vs first leg: `(price/first-1)`.
   * Drives one-way (down) DCA: avoid re-entries after relief rallies. Not in JSONL `open`; in-memory + restore via replay.
   */
  dcaLastEvalDropFromFirstPct?: number;
  /** TP-ladder pnl levels already used (0.05, 0.10, …) — legacy; kept for restore / JSONL without step index. */
  ladderUsedLevels: Set<number>;
  /** 0-based indices into the sorted `PAPER_TP_LADDER` rungs — canonical «already fired» marker. */
  ladderUsedIndices: Set<number>;
  /** W7.5 — pool/pair address from discovery snapshot (liquidity drain watch). */
  pairAddress: string | null;
  /** W7.5 — pool liquidity USD at entry (baseline for drain detection). */
  entryLiqUsd: number | null;
  /** W7.5 — consecutive tracker ticks with liquidity below drain threshold. */
  liqWatchConsecutiveFailures?: number;
  liqWatchLastLiqUsd?: number | null;
  liqWatchLastDropPct?: number | null;
  /** W7.5 — last good snapshot price from tracker (for emergency LIQ_DRAIN exit). */
  lastObservedPriceUsd?: number | null;
  /** W8.0-p4 — SPL decimals for Jupiter sizing (live-oscar); optional on paper restore. */
  tokenDecimals?: number | null;
  /**
   * W8.0-p7.1 — confirmed buy tx signatures (open first, then each DCA leg). Required for chain replay filtering.
   */
  entryLegSignatures?: string[];
  /** W8.0-p7.1 — `simulate` skips on-chain anchor verification at boot. */
  liveAnchorMode?: 'chain' | 'simulate';
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

/**
 * Rich context attached to every `close` event so the dashboard can render a
 * concrete, audit-ready exit reason (instead of just "TP" or "SL").
 *
 * Goal: when reviewing a closed trade you should be able to tell within ~2 sec
 * whether the exit was justified by checking peakPnlPct, retraceFromPeakPct,
 * triggerLabel, and whether the trail was actually armed.
 */
export interface ExitContext {
  /** Final realized PnL % from average entry (== ClosedTrade.pnlPct, copied for self-contained UI). */
  closePnlPct: number;
  /** Highest PnL % observed during the lifetime of the position. */
  peakPnlPct: number;
  /** ((peak - close) / peak) * 100. Positive number = how much we gave up after the peak. NaN if peak<=0. */
  retraceFromPeakPct: number | null;
  /** Whether trail mechanism actually armed (price reached cfg.trailTriggerX). */
  trailingArmed: boolean;
  /** Hours in position when the close fired. */
  ageHours: number;
  /** Number of TP-ladder levels that fired before final close. */
  tpLadderHits: number;
  /** Total TP-ladder levels configured for this strategy. */
  tpLadderTotal: number;
  /** Number of DCA legs added (excluding the initial entry leg). */
  dcaLegsAdded: number;
  /** Fraction of the position still open at the moment of final close (0 = fully sold via TP ladder). */
  remainingFractionAtClose: number;
  /** Short human label of the trigger that actually fired, e.g. "TP xAvg≥1.50", "SL xAvg≤0.90", "ladder retrace from 1.20x→below 1.10x", "peak retrace -10%", "TIMEOUT 1h", "DCA killstop -25%", "no-data 1h", "liq drop -84% in 60s". */
  triggerLabel: string;
  /** Strategy parameter snapshot at the moment of close — for audit (was tpX 1.5? trail 5 %?). */
  cfgSnapshot: {
    tpX: number;
    slX: number;
    trailMode: 'ladder_retrace' | 'peak';
    trailDrop: number;
    trailTriggerX: number;
    timeoutHours: number;
    dcaKillstop: number;
  };
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
  /** Audit-ready breakdown of why this trade closed; stamped by tracker. */
  exitContext?: ExitContext;
}

export type JsonlEventKind =
  | 'heartbeat'
  | 'eval'
  | 'eval-skip-open'
  | 'eval-skip-exit'
  | 'open'
  | 'peak'
  | 'dca_add'
  | 'partial_sell'
  | 'close'
  | 'followup_snapshot'
  | 'liq_watch_tick';

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
  /** W7.5 — exit counters including LIQ_DRAIN (same object as tracker stats RAM). */
  trackerStats?: Record<ExitReason, number>;
  /** W7.4.2 — deferred exits (blocked pre-exit Jupiter quote with block_on_fail). */
  skippedPriceVerifyExit?: number;
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
  /** Pool address from DEX snapshot row (W7.5). */
  pair_address: string | null;
}

export interface DipContext {
  high_px: number;
  low_px: number;
}

export interface SnapshotFeatures {
  price_usd: number;
  liq_usd: number;
  /** Pool/pair address from snapshot (W7.5). */
  pair_address: string | null;
  vol5m_usd: number;
  buys5m: number;
  sells5m: number;
  buy_sell_ratio_5m: number | null;
  holders: number;
  token_age_min: number;
  dip_pct: number | null;
  impulse_pct: number | null;
  /** Lookback window (minutes) that satisfied the dip OR-gate; null if eval failed or legacy rows. */
  dip_lookback_min: number | null;
  /** Pool-reported mcap (or FDV coalesced in SQL) at discovery row — stamped into jsonl for dashboards. */
  market_cap_usd: number | null;
  recovery_veto?: {
    threshold_pct: number;
    veto_windows_min: number[];
    dip_window_used_min: number | null;
    bounces_pct: Record<string, number>;
    vetoed: boolean;
    veto_reasons: string[];
  };
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
  /** См. `PAPER_ENTRY_IMPULSE_PG_BYPASS_DIP`; только наблюдаемость. */
  entry_path?: 'dip_windows' | 'impulse_pg_snap';
}

export interface EvalSkipOpenEvent extends JsonlEventBase {
  kind: 'eval-skip-open';
  lane: Lane;
  source?: string;
  mint: string;
  reason: string;
}

/** W7.4.2 — deferred exit because Jupiter pre-exit quote vs snapshot failed gates. */
export interface EvalSkipExitEvent extends JsonlEventBase {
  kind: 'eval-skip-exit';
  mint: string;
  context: 'partial_sell' | 'close';
  reason: string;
  priceVerifyExit: PriceVerifyVerdict;
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

/** W7.3 — live priority fee snapshot stamped onto open/dca_add/partial_sell/close events. */
export interface PriorityFeeQuote {
  microLamportsPerCu: number | null;
  computeUnits: number;
  usd: number;
  source: 'live' | 'fallback';
  ageMs: number | null;
  ts: number;
}

/** W7.5 — DEX snapshot source for pool liquidity lookup. */
export type DexSource =
  | 'raydium'
  | 'meteora'
  | 'orca'
  | 'moonshot'
  | 'pumpswap'
  | 'pump'
  | 'jupiter';

/**
 * W7.5 — liquidity drain watch verdict (per tracker tick).
 * Stamped onto `close` events with exitReason='LIQ_DRAIN'.
 */
export type LiqWatchVerdict =
  | {
      kind: 'ok';
      currentLiqUsd: number;
      dropPct: number;
      ageMs: number;
      from: 'snapshot' | 'rpc';
      ts: number;
    }
  | {
      kind: 'pending';
      currentLiqUsd: number | null;
      consecutiveFailures: number;
      ageMs: number | null;
      ts: number;
    }
  | {
      kind: 'force-close';
      reason: 'LIQ_DRAIN';
      currentLiqUsd: number;
      dropPct: number;
      ageMs: number;
      from: 'snapshot' | 'rpc';
      ts: number;
    }
  | {
      kind: 'skipped';
      reason:
        | 'feature-disabled'
        | 'no-pair-address'
        | 'no-entry-liq'
        | 'snapshot-stale'
        | 'rpc-disabled'
        | 'rpc-failed'
        | 'pre-min-age';
      ts: number;
    };

/** Wrapped SOL mint — Jupiter quote `inputMint` for SOL → token. */
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * W7.4 — pre-entry price verification verdict (Jupiter quote sanity check).
 * Stamped on `open` when cfg.priceVerifyEnabled === true.
 * W7.4.2 — same shape for pre-exit (token→SOL quote vs snapshot exit price).
 */
export type PriceVerifyVerdict =
  | {
      kind: 'ok';
      jupiterPriceUsd: number;
      snapshotPriceUsd: number;
      slipPct: number;
      priceImpactPct: number;
      routeHops: number;
      source: 'jupiter';
      ageMs: number;
      ts: number;
    }
  | {
      kind: 'blocked';
      jupiterPriceUsd: number;
      snapshotPriceUsd: number;
      slipPct: number;
      priceImpactPct: number;
      routeHops: number;
      reason: 'slip-too-high' | 'impact-too-high' | 'no-route';
      source: 'jupiter';
      ageMs: number;
      ts: number;
    }
  | {
      kind: 'skipped';
      reason:
        | 'feature-disabled'
        | 'sol-px-missing'
        | 'fetch-fail'
        | 'timeout'
        | 'http-error'
        | 'parse-error'
        | 'circuit-open';
      ts: number;
    };

/** W7.8 — on-chain `simulateTransaction` audit (Jupiter-unsigned build + QN). Stamped on `open` when enabled / sampled. */
export type SimAuditStamp =
  | { kind: 'skipped'; reason: string; ts: number; wallMs?: number }
  | {
      kind: 'ok' | 'err';
      ts: number;
      wallMs: number;
      qnCredits: number;
      err?: { code: number; message: string } | null;
      unitsConsumed?: number | null;
      buildKind: 'jupiter' | 'disabled';
      notes?: string;
    };

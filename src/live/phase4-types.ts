import type { CopyToOscarPromotionPlan } from './copy-to-oscar-promotion.js';
import type { PaperTraderConfig } from '../papertrader/config.js';
import type { EvalDecision } from '../papertrader/discovery/dip-clones.js';
import type { ClosedTrade, OpenTrade } from '../papertrader/types.js';
import type { LiveOscarConfig } from './config.js';

/** W8.0-p7.1 — outcome of SOL→token pipeline (live anchor vs simulate). */
export type LiveBuyAnchorMode = 'chain' | 'simulate';

/**
 * Terminal failure class for live SOL→token pipeline (1.11.230+).
 * Used by callers (staged add cooldown, retry policies) to react to specific failure modes
 * instead of treating every `ok: false` the same way.
 */
export type LiveBuyTerminalKind =
  | 'sim_err'
  | 'confirm_timeout'
  | 'send_failed'
  | 'chain_err'
  | 'no_quote'
  | 'swap_build'
  | 'quote_stale'
  | 'route_too_impactful'
  /**
   * 1.11.234 — anti-chase guard: между retry-итерациями buy-pipeline quote
   * ушёл по цене существенно выше anchor (первый успешный quote того же
   * pipeline-вызова). Чейзить не стоит — на следующий tick discovery либо
   * сделает свежий decision на актуальной цене, либо recovery-veto заблокирует.
   */
  | 'chase_aborted'
  | 'insufficient_funds'
  | 'gate'
  | 'other';

export interface LiveBuyPipelineResult {
  ok: boolean;
  anchorMode: LiveBuyAnchorMode;
  /** Populated when `anchorMode === 'chain'` and swap landed on-chain. */
  confirmedBuyTxSignature?: string | null;
  /** Actual USD notional executed when partial wallet slice applied (1.11.506). */
  executedUsdNotional?: number;
  /**
   * True when a sliced buy filled some — but not all — slices on-chain (partial success).
   * Callers MUST still record `executedUsdNotional` / `confirmedBuyTxSignatures` into the
   * ledger (no orphaned on-chain buys) and must NOT re-fire the whole add.
   */
  partial?: boolean;
  /** Terminal failure class (set only when `ok === false`). */
  terminalKind?: LiveBuyTerminalKind;
  /** Optional short message tail for diagnostics (≤200 chars). */
  terminalMessage?: string;
  /** Copy-leader handoff: top-up buy metadata for open-trade accounting. */
  copyToOscarPromotion?: CopyToOscarPromotionPlan;
  /** All confirmed buy tx signatures when entry was split into multiple Jupiter swaps. */
  confirmedBuyTxSignatures?: string[];
}

/** Mint + lane context after full Oscar entry gates (W8.0-p4 §4, §7). */
export interface LivePhase4BuyOpenContext {
  liveCfg: LiveOscarConfig;
  paperCfg: PaperTraderConfig;
  ot: OpenTrade;
  decision: EvalDecision;
  snapshotEntryPriceUsd: number;
  tokenDecimals: number | null;
}

export interface LiveOscarPhase4Discovery {
  /** When `ok`, caller must attach `entryLegSignatures` / `liveAnchorMode` before `live_position_open` JSONL. */
  tryExecuteBuyOpen(ctx: LivePhase4BuyOpenContext): Promise<LiveBuyPipelineResult>;
}

/** Token→SOL sell: chain proceeds when `solProceedsLamports` parsed from confirmed tx (live). */
export type LiveTokenToSolSellResult = {
  ok: boolean;
  /** Set when sell aborted before quote/sim (`execution_skip` reason). */
  preflightSkipReason?: string;
  solProceedsLamports?: bigint;
  /** Совпадает с `LiveTokenToSolPipelineResult.solProceedsSource` после свопа. */
  solProceedsSource?: 'confirmed_meta' | 'jupiter_quote';
  /** Подпись подтверждённой сделки (live), для оффлайн-аудита PnL по цепочке. */
  txSignature?: string | null;
  /**
   * 1.11.168: priceImpactPct из Jupiter quote (0..1, не %). Tracker использует
   * для записи в `partialSells[].priceImpactPct` — позволяет ретро считать leakage.
   */
  priceImpactPct?: number;
  /** 1.11.168: фактическое количество retry-попыток до успеха (0 = с первого раза). */
  retryAttempts?: number;
  sellAmountSource?: 'usd_math' | 'chain_full_balance' | 'usd_capped_by_chain';
  walletDrained?: boolean;
  /** Actual token atoms sold on-chain (sum across exit slices). Used for partial slipRealizedPct. */
  tokenAmountRawSold?: string;
  /** Terminal sell failure class when `ok === false`; callers keep retryable intents pending. */
  terminalKind?: 'sim_err' | 'send_failed' | 'confirm_timeout' | 'preflight' | 'other';
  /** Short terminal message for journal diagnostics and retry classification. */
  terminalMessage?: string;
};

/** Called after each successful exit slice (partial intent) for journal + chain resync. */
export type LiveExitSliceSuccessHook = (info: {
  sliceIndex: number;
  usdNotional: number;
  wsolOutLamports: bigint;
  tokenAmountRawSold?: string;
  txSignature?: string | null;
  sellAmountSource?: 'usd_math' | 'chain_full_balance' | 'usd_capped_by_chain';
  walletDrained?: boolean;
  priceImpactPct?: number;
}) => void | Promise<void>;

export type LiveTokenToSolPipelineResult = {
  ok: boolean;
  /** Set when sell aborted before quote/sim (`execution_skip` reason). */
  preflightSkipReason?: string;
  wsolOutLamports?: bigint;
  /** Откуда взяты lamports для учёта partial/full sell. */
  solProceedsSource?: 'confirmed_meta' | 'jupiter_quote';
  txSignature?: string | null;
  /**
   * 1.11.168: priceImpactPct из последней Jupiter-котировки (которая прошла) — 0..1, не %.
   * Прокидывается до tracker.ts для записи в `partialSells[].priceImpactPct`.
   */
  priceImpactPct?: number;
  /** 1.11.168: фактическое количество retry-попыток до успеха (0 = с первого раза). */
  retryAttempts?: number;
  sellAmountSource?: 'usd_math' | 'chain_full_balance' | 'usd_capped_by_chain';
  walletDrained?: boolean;
  /** Actual token atoms sold on-chain (sum across exit slices). Used for partial slipRealizedPct. */
  tokenAmountRawSold?: string;
  /** Terminal sell failure class when `ok === false`; callers keep retryable intents pending. */
  terminalKind?: 'sim_err' | 'send_failed' | 'confirm_timeout' | 'preflight' | 'other';
  /** Short terminal message for journal diagnostics and retry classification. */
  terminalMessage?: string;
};

export interface LiveOscarPhase4Tracker {
  trySolToTokenBuy(args: {
    mint: string;
    symbol: string;
    usdNotional: number;
    /** По умолчанию `dca_add`; вторая нога входа — `buy_scale_in`. */
    intentKind?: 'dca_add' | 'buy_scale_in';
    /** low/prod mcap tier at entry — enables Jupiter buy slicing for staged adds. */
    entryBuySliceEligible?: boolean;
    /**
     * Hard per-position notional ceiling (USD) for this mint. When set (live mode),
     * the add is clamped/blocked against the REAL wallet holding so cumulative buys
     * never exceed the tier plan cap even if the ledger is out of sync.
     */
    positionCeilingUsd?: number;
    /** Token decimals — required to value the on-chain wallet holding for the ceiling gate. */
    tokenDecimals?: number | null;
    /** Dex source — used to pick the snapshot price feed when valuing wallet holding. */
    dexSource?: string;
  }): Promise<LiveBuyPipelineResult>;

  tryTokenToSolSell(args: {
    mint: string;
    symbol: string;
    usdNotional: number;
    priceUsdPerToken: number;
    /** Prior observed / entry anchor for ghost-quote deviation gate. */
    referencePriceUsd?: number | null;
    decimals: number;
    intentKind: 'sell_partial' | 'sell_full';
    onSliceSuccess?: LiveExitSliceSuccessHook;
    /** KILLSTOP / mem-swan: skip ghost-quote gate, no exit slicing, aggressive sim retry. */
    emergencyExit?: boolean;
  }): Promise<LiveTokenToSolSellResult>;
}

export interface LiveOscarRuntimeBundle {
  liveCfg: LiveOscarConfig;
  discovery: LiveOscarPhase4Discovery;
  tracker: LiveOscarPhase4Tracker;
}

/** Paper Oscar maps — Phase 5 risk/capital (W8.0-p5). */
export interface LiveOscarStrategyDeps {
  getOpen: () => Map<string, OpenTrade>;
  getClosed: () => ClosedTrade[];
  /**
   * После успешного `sell_full` в ротации капитала — синхронизировать `open`/`closed` и `live_position_close`
   * (иначе трекер позже закроет как RECONCILE_ORPHAN).
   */
  finalizeCapitalRotatePaperClose?: (
    mint: string,
    marketSellPx: number,
    liveCfg: LiveOscarConfig,
  ) => Promise<void>;
}

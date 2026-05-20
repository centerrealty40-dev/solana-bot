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
  | 'insufficient_funds'
  | 'gate'
  | 'other';

export interface LiveBuyPipelineResult {
  ok: boolean;
  anchorMode: LiveBuyAnchorMode;
  /** Populated when `anchorMode === 'chain'` and swap landed on-chain. */
  confirmedBuyTxSignature?: string | null;
  /** Terminal failure class (set only when `ok === false`). */
  terminalKind?: LiveBuyTerminalKind;
  /** Optional short message tail for diagnostics (≤200 chars). */
  terminalMessage?: string;
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
};

export interface LiveOscarPhase4Tracker {
  trySolToTokenBuy(args: {
    mint: string;
    symbol: string;
    usdNotional: number;
    /** По умолчанию `dca_add`; вторая нога входа — `buy_scale_in`. */
    intentKind?: 'dca_add' | 'buy_scale_in';
  }): Promise<LiveBuyPipelineResult>;

  tryTokenToSolSell(args: {
    mint: string;
    symbol: string;
    usdNotional: number;
    priceUsdPerToken: number;
    decimals: number;
    intentKind: 'sell_partial' | 'sell_full';
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

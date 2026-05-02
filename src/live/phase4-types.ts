import type { PaperTraderConfig } from '../papertrader/config.js';
import type { EvalDecision } from '../papertrader/discovery/dip-clones.js';
import type { ClosedTrade, OpenTrade } from '../papertrader/types.js';
import type { LiveOscarConfig } from './config.js';

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
  /** Returns true if in-memory position should be opened (simulate ok or policy). */
  tryExecuteBuyOpen(ctx: LivePhase4BuyOpenContext): Promise<boolean>;
}

export interface LiveOscarPhase4Tracker {
  trySolToTokenBuy(args: { mint: string; symbol: string; usdNotional: number }): Promise<boolean>;

  tryTokenToSolSell(args: {
    mint: string;
    symbol: string;
    usdNotional: number;
    priceUsdPerToken: number;
    decimals: number;
    intentKind: 'sell_partial' | 'sell_full';
  }): Promise<boolean>;
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
}

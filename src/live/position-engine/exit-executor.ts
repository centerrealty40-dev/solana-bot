import type { LiveOscarConfig } from '../config.js';
import type { OpenTrade, ExitReason } from '../../papertrader/types.js';
import type { LiveTokenToSolSellResult } from '../phase4-types.js';
import { markLiveUpeExitInFlight } from './entry-policy.js';
import {
  logUpeExitBlock,
  tryBlockLiveExitViaUpe,
  type UpeExitBlockResult,
} from './tracker-hook.js';

export type GuardedFullExitBlock = Extract<UpeExitBlockResult, { blocked: true }>;

/** UPE guard before any live full exit (LIQ_DRAIN, VOL_COLLAPSE, policy, emergency). */
export function guardLiveFullExit(args: {
  ot: OpenTrade;
  mint: string;
  exitReason: ExitReason;
  chainMap: Map<string, bigint> | null | undefined;
  chainOscarUsd: number;
  priceUsd: number;
  liveOscarCfg: LiveOscarConfig | undefined;
  emergency?: boolean;
}): UpeExitBlockResult {
  return tryBlockLiveExitViaUpe({
    ot: args.ot,
    mint: args.mint,
    exitReason: args.exitReason,
    chainMap: args.chainMap,
    chainOscarUsd: args.chainOscarUsd,
    priceUsd: args.priceUsd,
    liveOscarCfg: args.liveOscarCfg,
    emergency: args.emergency,
  });
}

export function logGuardedFullExitBlock(args: {
  mint: string;
  symbol: string;
  exitReason: ExitReason;
  block: GuardedFullExitBlock;
}): void {
  logUpeExitBlock({
    mint: args.mint,
    symbol: args.symbol,
    exitReason: args.exitReason,
    block: args.block,
  });
}

/** Wrap Jupiter full sell with UPE-I5 in-flight mutex. */
export async function withUpeFullExitInFlight<T>(
  ot: OpenTrade,
  fn: () => Promise<T>,
): Promise<T> {
  markLiveUpeExitInFlight(ot, true);
  try {
    return await fn();
  } finally {
    markLiveUpeExitInFlight(ot, false);
  }
}

export type GuardedFullSellOutcome =
  | { status: 'blocked'; block: GuardedFullExitBlock }
  | { status: 'sold'; sellOut: LiveTokenToSolSellResult }
  | { status: 'sell_failed'; sellOut: LiveTokenToSolSellResult };

/**
 * Unified full-exit sell funnel (Phase D): guard → in-flight → sell.
 * Caller owns journal close / buildClosedTrade.
 */
export async function runGuardedLiveFullSell(args: {
  ot: OpenTrade;
  mint: string;
  exitReason: ExitReason;
  chainMap: Map<string, bigint> | null | undefined;
  chainOscarUsd: number;
  priceUsd: number;
  liveOscarCfg: LiveOscarConfig | undefined;
  emergency?: boolean;
  investedRemainingUsd: number;
  sell: (usdNotional: number) => Promise<LiveTokenToSolSellResult>;
}): Promise<GuardedFullSellOutcome> {
  const block = guardLiveFullExit(args);
  if (block.blocked) return { status: 'blocked', block };

  const usd = args.investedRemainingUsd;
  if (!(usd > 1e-6)) {
    return { status: 'sold', sellOut: { ok: true } };
  }

  const sellOut = await withUpeFullExitInFlight(args.ot, () => args.sell(usd));
  if (!sellOut.ok) return { status: 'sell_failed', sellOut };
  return { status: 'sold', sellOut };
}

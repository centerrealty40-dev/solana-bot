import type {
  Address,
  ExitSignal,
  HypothesisSignal,
  MarketCtx,
  Mint,
  NormalizedSwap,
  WalletScore,
} from '../core/types.js';

export type { ExitSignal, HypothesisSignal, MarketCtx, NormalizedSwap, WalletScore, Address, Mint };

/**
 * Standard interface every hypothesis module implements.
 *
 * Lifecycle: the runner calls `onSwap` for every freshly-ingested swap that touches a
 * candidate token. The hypothesis returns 0..1 entry signals. On every position the
 * hypothesis owns, the runner calls `shouldExit` periodically (every ~10s) with current
 * market context.
 *
 * Hypotheses are pure (no DB writes); the runner persists signals & positions.
 */
export interface Hypothesis {
  id: string;
  describe(): string;

  /**
   * Called for each newly-observed swap on a "tracked" token.
   * The hypothesis chooses which tokens are tracked via `subscribeToToken(mint)`.
   *
   * @returns one or more entry signals to consider, or null if nothing.
   */
  onSwap(swap: NormalizedSwap, ctx: MarketCtx): HypothesisSignal[] | null;

  /**
   * Called periodically by the runner for each open position belonging to this hypothesis.
   *
   * @returns an exit signal (with fraction) or null to keep holding.
   */
  shouldExit(
    position: HypothesisPositionView,
    ctx: MarketCtx,
  ): ExitSignal | null;

  /**
   * Optional one-time setup at runner start (e.g. loading watchlist).
   */
  init?(): Promise<void> | void;
}

/**
 * Read-only snapshot of a position passed to `shouldExit`.
 */
export interface HypothesisPositionView {
  positionId: bigint;
  hypothesisId: string;
  baseMint: Mint;
  quoteMint: Mint;
  openedAt: Date;
  sizeUsd: number;
  entryPriceUsd: number;
  baseAmountRaw: bigint;
  /** payload originally attached by the entry signal */
  signalMeta: Record<string, unknown>;
  /** current best-known price for the base mint */
  currentPriceUsd: number;
  /** unrealized PnL in USD */
  unrealizedPnlUsd: number;
  /** how many partial exits already executed (0 = nothing sold yet) */
  exitsCount: number;
}

/**
 * Helper for hypotheses to build a signal with sane defaults.
 */
export function buildSignal(
  hypothesisId: string,
  baseMint: Mint,
  side: 'buy' | 'sell',
  sizeUsd: number,
  reason: string,
  meta: Record<string, unknown> = {},
): HypothesisSignal {
  return {
    hypothesisId,
    ts: new Date(),
    baseMint,
    side,
    sizeUsd,
    reason,
    meta,
  };
}

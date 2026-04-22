/**
 * Domain types shared across collectors, scoring, hypotheses and runner.
 *
 * Money convention:
 *   - All USD values are stored as `number` for analytics convenience but should be treated as 6-decimal USDC values.
 *   - All token amounts are stored as `bigint` lamports/raw units to avoid float precision loss.
 */

export type Address = string;
export type TxSignature = string;
export type Mint = string;

export type ChainId = 'solana';

export type SwapSide = 'buy' | 'sell';

/** A single normalized swap event after going through the Normalizer. */
export interface NormalizedSwap {
  signature: TxSignature;
  slot: number;
  blockTime: Date;
  wallet: Address;
  /** the non-quote token traded */
  baseMint: Mint;
  /** quote currency (SOL/USDC/USDT) */
  quoteMint: Mint;
  side: SwapSide;
  /** raw base amount, positive */
  baseAmountRaw: bigint;
  /** raw quote amount, positive */
  quoteAmountRaw: bigint;
  /** USD value of the trade at execution time (best effort) */
  priceUsd: number;
  amountUsd: number;
  /** which DEX program executed it */
  dex: 'raydium' | 'jupiter' | 'pumpfun' | 'meteora' | 'orca' | 'unknown';
  source: 'helius_webhook' | 'dexscreener' | 'birdeye' | 'pumpportal' | 'manual';
}

export interface TokenInfo {
  mint: Mint;
  symbol: string | null;
  name: string | null;
  decimals: number;
  /** dev/deployer wallet, best effort */
  devWallet: Address | null;
  /** when we first saw it on-chain */
  firstSeenAt: Date;
  /** holder count snapshot, may be stale */
  holderCount: number | null;
}

export interface PriceSample {
  mint: Mint;
  ts: Date;
  priceUsd: number;
  volumeUsd5m: number;
}

/** A signal raised by a hypothesis, before risk check / execution. */
export interface HypothesisSignal {
  hypothesisId: string;
  ts: Date;
  baseMint: Mint;
  side: SwapSide;
  /** suggested position size in USD (subject to risk manager cap) */
  sizeUsd: number;
  /** human-readable reason — for analytics & debugging */
  reason: string;
  /** opaque payload used by the same hypothesis when generating exit signal */
  meta: Record<string, unknown>;
}

export interface ExitSignal {
  reason: string;
  /** 0..1, fraction of the position to close */
  fraction: number;
}

export type ExecutorMode = 'paper' | 'live';

export interface PaperFill {
  signature: null;
  baseAmountRaw: bigint;
  quoteAmountRaw: bigint;
  priceUsd: number;
  /** simulated slippage applied vs. mid price, signed: positive when worse */
  slippageBps: number;
  feeUsd: number;
  ts: Date;
}

export interface LiveFill {
  signature: TxSignature;
  baseAmountRaw: bigint;
  quoteAmountRaw: bigint;
  priceUsd: number;
  slippageBps: number;
  feeUsd: number;
  ts: Date;
}

export type Fill = PaperFill | LiveFill;

export interface RecentSignalAgg {
  hypothesisId: string;
  side: SwapSide;
  /** how many signals from this hypothesis fired on this mint within the lookback window */
  count: number;
  /** most recent signal timestamp */
  lastTs: Date;
  /** most recent signal id (FK back to signals.id) */
  lastSignalId: bigint;
  /** most recent reason text */
  lastReason: string;
}

export interface MarketCtx {
  /** time of evaluation (paper trade may use historical time) */
  now: Date;
  /** all swaps for this token in the last 1h, newest first */
  recentSwaps: NormalizedSwap[];
  /** price/volume samples in last hour */
  priceSamples: PriceSample[];
  /** wallet scores (read-only snapshot) */
  scores: ReadonlyMap<Address, WalletScore>;
  /**
   * Aggregated recent signals from OTHER hypotheses on this mint, keyed by hypothesisId.
   * Lookback window: 60 minutes. Used by meta-hypotheses (e.g. H7 confluence gate)
   * to synchronously check cross-hypothesis convergence without an extra DB query.
   */
  recentSignals: Map<string, RecentSignalAgg>;
}

export interface WalletScore {
  wallet: Address;
  earlyEntryScore: number;
  realizedPnl30d: number;
  holdingAvgMinutes: number;
  sellInTranchesRatio: number;
  fundingOriginAgeDays: number;
  clusterId: string | null;
  consistencyScore: number;
  updatedAt: Date;
}

import type { ComboBuyLeg } from '../pumpswap-combo/types.js';

export type FollowPosition = {
  mint: string;
  symbol: string;
  poolAddress?: string;
  openedAt: number;
  legs: ComboBuyLeg[];
  botPeakUsd: number;
  /** Ladder rung ids already executed (tp1, tp2, …). */
  rungsTaken: string[];
  leaderWallet: string;
  /** Paper: fraction of original bag still held (live uses chain balance). */
  remainingFrac: number;
};

export type LeaderMintLedger = {
  tokenRaw: string;
};

export type PendingFollowBuy = {
  id: string;
  mint: string;
  symbol: string;
  kind: 'entry' | 'add';
  leaderSignature: string;
  leaderPriceUsd: number;
  leaderBuyUsd: number;
  /** PumpSwap pool from leader tx / canonical PDA — survives PG indexer lag. */
  poolAddress?: string;
  /** Unix sec from RPC signature row when available. */
  leaderBlockTimeSec?: number;
  dueTs: number;
  retryUntilTs: number;
};

export type LeaderSellRef = {
  ts: number;
  signature: string;
  priceUsd: number;
};

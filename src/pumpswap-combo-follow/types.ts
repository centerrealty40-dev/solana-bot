import type { ComboBuyLeg } from '../pumpswap-combo/types.js';
import type { FollowWaveBState } from './follow-wave-b-state.js';

export type FollowPosition = {
  mint: string;
  symbol: string;
  poolAddress?: string;
  openedAt: number;
  legs: ComboBuyLeg[];
  botPeakUsd: number;
  /** Ladder rung ids already executed (tp1, tp2, …) — legacy leader-ladder mode. */
  rungsTaken: string[];
  leaderWallet: string;
  /** Paper: fraction of original bag still held (live uses chain balance). */
  remainingFrac: number;
  /** Live Oscar wave B exit + DCA state (`oscar_wave_b` policy). */
  waveB?: FollowWaveBState;
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
  /** USD notional of this leader sell (for conditional flush). */
  sellUsd?: number;
  /** Leader token balance after sell (0 = full exit / rug follow). */
  leaderPostBalanceRaw?: string;
  leaderFlat?: boolean;
};

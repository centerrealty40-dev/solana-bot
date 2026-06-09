export type ComboBuyLeg = {
  ts: number;
  usd: number;
  fillPriceUsd: number;
  txSignature?: string;
};

export type ComboPosition = {
  mint: string;
  symbol: string;
  /** PumpSwap AMM pool (PG pair_address) — direct executor only. */
  poolAddress?: string;
  openedAt: number;
  legs: ComboBuyLeg[];
  botPeakUsd: number;
  tp1Taken: boolean;
};

export type WatchlistRow = {
  mint: string;
  symbol: string;
  /** PumpSwap pool pubkey from PG — same venue as signal. */
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  marketCapUsd: number;
  snapshotTs: number;
  /** Max PG price in rollingHighWindow — dump signal vs current price. */
  high15mUsd: number;
  /** Min PG price in rollingHighWindow. */
  low15mUsd: number;
  /** When low_15m was observed (ms) — freshness gate for live dump. */
  low15mTs: number;
};

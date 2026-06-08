export type PumpswapDipExecutionMode = 'paper' | 'dry_run' | 'live';

export type PumpswapDipPosition = {
  mint: string;
  symbol: string;
  entryTs: number;
  entryPriceUsd: number;
  sizeUsd: number;
  tokenRaw?: string;
  txSignature?: string;
  dumpPctAtEntry: number;
};

export type WatchlistRow = {
  mint: string;
  symbol: string;
  priceUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  marketCapUsd: number;
  pairAddress: string | null;
  snapshotTs: number;
};

export type PriceSample = { ts: number; priceUsd: number };

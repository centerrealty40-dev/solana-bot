/** L1 TWAP order action from HypurrScan `twap/*` indexer (mirrors on-chain twapOrder). */
export type HypurrscanTwapAction = {
  type: 'twapOrder';
  twap: {
    /** Perp universe index, or spot market id (often >= 10000). */
    a: number;
    /** true = buy (Bid), false = sell (Ask). */
    b: boolean;
    s: string;
    r: boolean;
    /** Duration in minutes. */
    m: number;
    t: boolean;
  };
};

export type HypurrscanTwapRow = {
  time: number;
  user: string;
  action: HypurrscanTwapAction;
  block: number;
  hash: string;
  error: string | null;
  /** Present when TWAP finished, cancelled, or errored. */
  ended?: string;
};

export type TwapSide = 'buy' | 'sell';

export type ResolvedTwapMarket = {
  coin: string;
  displaySymbol: string;
  isSpot: boolean;
  assetId: number;
  midPx: number;
  /** 24h notional volume (USD) from metaAndAssetCtxs when perp. */
  dayNtlVlmUsd: number | null;
};

export type NormalizedTwapSignal = {
  hash: string;
  twapId: number | null;
  user: string;
  side: TwapSide;
  coin: string;
  displaySymbol: string;
  isSpot: boolean;
  size: number;
  minutes: number;
  randomize: boolean;
  reduceOnly: boolean;
  notionalUsd: number;
  midPx: number;
  dayNtlVlmUsd: number | null;
  volumeSharePct: number | null;
  startedAtMs: number;
  block: number;
  ended: string | null;
};

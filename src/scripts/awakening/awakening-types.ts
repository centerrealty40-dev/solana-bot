/** DexScreener market view for dormant-low awakening evaluation. */
export interface AwakeningDexMarket {
  mint: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  volume6hUsd: number | null;
  volume24hUsd: number | null;
  buys5m: number | null;
  sells5m: number | null;
  priceChangeM5: number | null;
  priceChangeH1: number | null;
  priceChangeH6: number | null;
  priceChangeH24: number | null;
  pairAddress: string | null;
  dexId: string | null;
  /** Pool age from DexScreener `pairCreatedAt` (minutes). */
  poolAgeMin: number | null;
  fetchedAtMs: number;
}

export interface AwakeningSignalMetrics {
  vol5mUsd: number;
  vol1hUsd: number;
  vol6hUsd: number;
  vol24hUsd: number;
  priorVol6hUsd: number;
  volVelocity: number;
  vol5mToVol1hRatio: number | null;
  vol1hToVol6hRatio: number | null;
  /** Hourly turnover vol1h/mcap — wash/cluster proxy. */
  vol1hPerMcap: number | null;
  poolAgeMin: number | null;
  buyRatio: number | null;
}

export interface AwakeningSignalResult {
  pass: boolean;
  reasons: string[];
  metrics: AwakeningSignalMetrics;
}

export type AwakeningCandidateSource = 'stream_pulse' | 'gecko_trending' | 'dex_search';

export interface AwakeningCandidate {
  mint: string;
  source: AwakeningCandidateSource;
  streamSigCount5m?: number;
}

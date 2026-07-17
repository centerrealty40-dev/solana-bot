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
  /** Volume in the ~55m window before the current 5m bucket (vol1h − vol5m). */
  priorVol1hUsd: number;
  /** Avg $/5m over prior ~6h (excludes current vol5m). */
  prior6h5mAvgUsd: number;
  /** Avg $/5m over prior ~55m (excludes current vol5m). */
  prior1h5mAvgUsd: number;
  /** vol5m / prior 6h 5m-average — fresh dormant burst vs sustained flow. */
  vol5mSpikeVs6hMult: number;
  /** vol5m / prior 1h 5m-average — start of hour spike vs mid-rally continuation. */
  vol5mSpikeVs1hMult: number;
  volVelocity: number;
  vol5mToVol1hRatio: number | null;
  vol1hToVol6hRatio: number | null;
  /** Hourly turnover vol1h/mcap — wash/cluster proxy. */
  vol1hPerMcap: number | null;
  /** vol1h / prior-6h hourly avg — gradual awakening ramp. */
  vol1hSpikeVs6hHourlyMult: number;
  poolAgeMin: number | null;
  buyRatio: number | null;
  /** Which eval path passed (ignition burst vs gradual vol build). */
  entryPath?: 'early_spike' | 'ignition' | 'gradual';
}

export interface AwakeningSignalResult {
  pass: boolean;
  reasons: string[];
  metrics: AwakeningSignalMetrics;
}

export type AwakeningCandidateSource =
  | 'stream_pulse'
  | 'stream_warm'
  | 'gecko_trending'
  | 'dex_search';

export interface AwakeningCandidate {
  mint: string;
  source: AwakeningCandidateSource;
  streamSigCount5m?: number;
}

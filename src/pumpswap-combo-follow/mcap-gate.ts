import { fetchDexInfo } from '../copytrader/dex-info.js';
import { fetchLatestSnapshotMcap } from '../papertrader/pricing.js';
import type { PumpswapComboFollowConfig } from './config.js';

export type McapGateVerdict = {
  pass: boolean;
  reason?: 'min_mcap_usd' | 'max_mcap_usd' | 'mcap_missing_or_zero';
  marketCapUsd?: number | null;
};

/** Pure gate — testable without RPC. */
export function evaluateFollowMcapGate(
  cfg: Pick<PumpswapComboFollowConfig, 'minMarketCapUsd' | 'maxMarketCapUsd'>,
  marketCapUsd: number | null | undefined,
): McapGateVerdict {
  const min = cfg.minMarketCapUsd;
  const max = cfg.maxMarketCapUsd;
  if (!(min > 0) && !(max > 0)) return { pass: true, marketCapUsd: marketCapUsd ?? null };

  const mcap = marketCapUsd ?? 0;
  if (min > 0 && !(mcap > 0)) {
    return { pass: false, reason: 'mcap_missing_or_zero', marketCapUsd: mcap };
  }
  if (min > 0 && mcap < min) {
    return { pass: false, reason: 'min_mcap_usd', marketCapUsd: mcap };
  }
  if (max > 0 && mcap > max) {
    return { pass: false, reason: 'max_mcap_usd', marketCapUsd: mcap };
  }
  return { pass: true, marketCapUsd: mcap };
}

/** PG pumpswap snapshot first, DexScreener fallback. */
export async function resolveFollowEntryMarketCapUsd(mint: string): Promise<number | null> {
  const pg = await fetchLatestSnapshotMcap(mint, 'pumpswap');
  if (pg != null && pg > 0) return pg;
  const dex = await fetchDexInfo(mint, 1);
  if (dex?.marketCap && dex.marketCap > 0) return dex.marketCap;
  return null;
}

export async function checkFollowMcapGate(
  cfg: PumpswapComboFollowConfig,
  mint: string,
): Promise<McapGateVerdict> {
  if (!(cfg.minMarketCapUsd > 0) && !(cfg.maxMarketCapUsd > 0)) {
    return { pass: true };
  }
  const marketCapUsd = await resolveFollowEntryMarketCapUsd(mint);
  return evaluateFollowMcapGate(cfg, marketCapUsd);
}

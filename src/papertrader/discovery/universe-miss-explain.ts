import type { PaperTraderConfig } from '../config.js';
import { laneCfg } from '../filters/snapshot-filter.js';
import { resolveDiscoverySqlMinMarketCapUsd } from './discovery-mcap-floor.js';
import type { SnapshotCandidateRow } from '../types.js';

const SNAPSHOT_MAX_STALE_MS = 30 * 60 * 1000;

function tsMs(row: SnapshotCandidateRow): number | null {
  const t = row.ts;
  if (t instanceof Date) return t.getTime();
  const n = new Date(String(t)).getTime();
  return Number.isFinite(n) ? n : null;
}

/**
 * Mirrors `fetchSnapshotLaneCandidates` post_migration WHERE filters (probe row from cross-venue snapshot fetch).
 */
export function explainPostLaneUniverseMiss(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow | null,
): { reasons: string[]; symbol?: string } {
  if (!row) {
    return { reasons: ['no_snapshot_row_30m_any_venue'] };
  }
  const lc = laneCfg(cfg, 'post_migration');
  const reasons: string[] = [];
  const tms = tsMs(row);
  if (tms == null) reasons.push('snapshot_ts_unparseable');
  else {
    const staleMs = Date.now() - tms;
    if (staleMs > SNAPSHOT_MAX_STALE_MS) {
      reasons.push(`snapshot_ts_stale_${Math.round(staleMs / 60_000)}m_gt_30m_sql_window`);
    }
  }
  const px = Number(row.price_usd ?? 0);
  if (!(px > 0)) reasons.push('price_usd_missing_or_zero');

  const ageMin = Number(row.age_min ?? 0);
  if (!(ageMin >= lc.MIN_AGE_MIN)) {
    reasons.push(`pool_age_min_${ageMin.toFixed(1)}<${lc.MIN_AGE_MIN}`);
  }
  if (lc.MAX_AGE_MIN > 0 && ageMin > lc.MAX_AGE_MIN) {
    reasons.push(`pool_age_min_${ageMin.toFixed(1)}>${lc.MAX_AGE_MIN}`);
  }

  const liq = Number(row.liquidity_usd ?? 0);
  if (!(liq >= lc.MIN_LIQ_USD)) {
    reasons.push(`liquidity_usd_${liq.toFixed(0)}<${lc.MIN_LIQ_USD}`);
  }
  if (lc.MAX_LIQ_USD > 0 && liq > lc.MAX_LIQ_USD) {
    reasons.push(`liquidity_usd_${liq.toFixed(0)}>${lc.MAX_LIQ_USD}`);
  }

  const v5 = Number(row.volume_5m ?? 0);
  if (!(v5 >= lc.MIN_VOL_5M_USD)) {
    reasons.push(`volume_5m_${v5.toFixed(0)}<${lc.MIN_VOL_5M_USD}`);
  }
  if (lc.MAX_VOL_5M_USD > 0 && v5 > lc.MAX_VOL_5M_USD) {
    reasons.push(`volume_5m_${v5.toFixed(0)}>${lc.MAX_VOL_5M_USD}`);
  }

  const buys = Number(row.buys_5m ?? 0);
  const sells = Number(row.sells_5m ?? 0);
  if (!(buys >= lc.MIN_BUYS_5M)) {
    reasons.push(`buys_5m_${buys}<${lc.MIN_BUYS_5M}`);
  }
  if (!(sells >= lc.MIN_SELLS_5M)) {
    reasons.push(`sells_5m_${sells}<${lc.MIN_SELLS_5M}`);
  }

  const minMcap = resolveDiscoverySqlMinMarketCapUsd(cfg);
  const maxMcap = cfg.discoveryMaxMarketCapUsd ?? 0;
  const refMcap = Number(row.market_cap_usd ?? 0);
  if (minMcap > 0 && !(refMcap >= minMcap)) {
    reasons.push(`market_cap_usd_${refMcap.toFixed(0)}<${minMcap}`);
  }
  if (maxMcap > 0 && refMcap > maxMcap) {
    reasons.push(`market_cap_usd_${refMcap.toFixed(0)}>${maxMcap}`);
  }

  return { reasons, symbol: row.symbol };
}

export function explainCrowdedOutOnly(
  cfg: PaperTraderConfig,
  sqlReasonsEmpty: boolean,
): string | null {
  if (!sqlReasonsEmpty) return null;
  return `crowded_out_snapshot_candidate_limit_${cfg.snapshotCandidateLimit}`;
}

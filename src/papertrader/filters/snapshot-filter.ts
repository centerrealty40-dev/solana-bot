import type { PaperTraderConfig } from '../config.js';
import type { Lane, SnapshotCandidateRow } from '../types.js';

interface LaneCfg {
  MIN_LIQ_USD: number;
  MIN_VOL_5M_USD: number;
  MIN_BUYS_5M: number;
  MIN_SELLS_5M: number;
  MIN_AGE_MIN: number;
  MAX_AGE_MIN: number;
}

export function laneCfg(cfg: PaperTraderConfig, lane: Lane): LaneCfg {
  if (lane === 'migration_event') {
    return {
      MIN_LIQ_USD: cfg.laneMigMinLiqUsd,
      MIN_VOL_5M_USD: cfg.laneMigMinVol5mUsd,
      MIN_BUYS_5M: cfg.laneMigMinBuys5m,
      MIN_SELLS_5M: cfg.laneMigMinSells5m,
      MIN_AGE_MIN: cfg.laneMigMinAgeMin,
      MAX_AGE_MIN: cfg.laneMigMaxAgeMin,
    };
  }
  return {
    MIN_LIQ_USD: cfg.lanePostMinLiqUsd,
    MIN_VOL_5M_USD: cfg.lanePostMinVol5mUsd,
    MIN_BUYS_5M: cfg.lanePostMinBuys5m,
    MIN_SELLS_5M: cfg.lanePostMinSells5m,
    MIN_AGE_MIN: cfg.lanePostMinAgeMin,
    MAX_AGE_MIN: cfg.lanePostMaxAgeMin,
  };
}

export function evaluateSnapshot(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  lane: Lane,
): { pass: boolean; reasons: string[] } {
  const lc = laneCfg(cfg, lane);
  const reasons: string[] = [];
  if (row.liquidity_usd < lc.MIN_LIQ_USD) reasons.push(`liq<${lc.MIN_LIQ_USD}`);
  if (row.volume_5m < lc.MIN_VOL_5M_USD) reasons.push(`vol5m<${lc.MIN_VOL_5M_USD}`);
  if (row.buys_5m < lc.MIN_BUYS_5M) reasons.push(`buys5m<${lc.MIN_BUYS_5M}`);
  if (row.sells_5m < lc.MIN_SELLS_5M) reasons.push(`sells5m<${lc.MIN_SELLS_5M}`);
  const bs = row.sells_5m > 0 ? row.buys_5m / row.sells_5m : row.buys_5m;
  if (bs < cfg.snapshotMinBs) reasons.push(`bs<${cfg.snapshotMinBs}`);
  return { pass: reasons.length === 0, reasons };
}

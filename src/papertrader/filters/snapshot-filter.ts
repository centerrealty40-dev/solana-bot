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

/**
 * Compare last 5m volume vs hourly aggregate from the same DEX snapshot row.
 * Rejects wash-style spikes: high vol_5m with thin vol_1h (or missing hour).
 * Disabled when `cfg.vol5m1hGuardEnabled` is false (legacy behavior).
 */
export function evaluateVol5m1hGuard(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
): { pass: boolean; reasons: string[] } {
  if (!cfg.vol5m1hGuardEnabled) return { pass: true, reasons: [] };
  const vol5m = Number(row.volume_5m ?? 0);
  const vol1h = Number(row.volume_1h ?? 0);
  if (!Number.isFinite(vol1h) || vol1h <= 0) {
    return { pass: false, reasons: ['vol1h_missing'] };
  }
  if (vol1h < cfg.vol1hMinUsd) {
    return { pass: false, reasons: [`vol1h<${cfg.vol1hMinUsd}`] };
  }
  const baseline5m = vol1h / 12;
  if (!(baseline5m > 0)) {
    return { pass: false, reasons: ['vol1h_baseline_zero'] };
  }
  const ratio = vol5m / baseline5m;
  if (ratio > cfg.vol5mSpikeMaxMult) {
    return {
      pass: false,
      reasons: [`vol5m_spike>${cfg.vol5mSpikeMaxMult}x_hour_avg(${ratio.toFixed(1)}x)`],
    };
  }
  return { pass: true, reasons: [] };
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
  const vh = evaluateVol5m1hGuard(cfg, row);
  if (!vh.pass) reasons.push(...vh.reasons);
  return { pass: reasons.length === 0, reasons };
}

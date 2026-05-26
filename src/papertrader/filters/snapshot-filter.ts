import type { PaperTraderConfig } from '../config.js';
import type { Lane, SnapshotCandidateRow } from '../types.js';

interface LaneCfg {
  MIN_LIQ_USD: number;
  MAX_LIQ_USD: number;
  MIN_VOL_5M_USD: number;
  MAX_VOL_5M_USD: number;
  MIN_BUYS_5M: number;
  MIN_SELLS_5M: number;
  MIN_AGE_MIN: number;
  MAX_AGE_MIN: number;
}

/** Ref mcap from snapshot row (SQL already COALESCE market_cap_usd, fdv_usd). */
export function snapshotRefMarketCapUsd(row: SnapshotCandidateRow): number {
  const n = Number(row.market_cap_usd ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Discovery min mcap gate (`PAPER_DISCOVERY_MIN_MARKET_CAP_USD`; 0 = off). */
export function passesDiscoveryMinMarketCap(cfg: PaperTraderConfig, row: SnapshotCandidateRow): boolean {
  const minMcap = cfg.discoveryMinMarketCapUsd ?? 0;
  if (minMcap <= 0) return true;
  return snapshotRefMarketCapUsd(row) + 1e-9 >= minMcap;
}

/** Smart Lottery paper strategy — separate snapshot thresholds from dip Oscar lanes. */
export function smartLotteryLaneCfg(cfg: PaperTraderConfig, lane: Lane): LaneCfg {
  if (lane === 'migration_event') {
    return {
      MIN_LIQ_USD: cfg.smlotMigMinLiqUsd,
      MAX_LIQ_USD: cfg.smlotMigMaxLiqUsd,
      MIN_VOL_5M_USD: cfg.smlotMigMinVol5mUsd,
      MAX_VOL_5M_USD: 0,
      MIN_BUYS_5M: cfg.smlotMigMinBuys5m,
      MIN_SELLS_5M: cfg.smlotMigMinSells5m,
      MIN_AGE_MIN: cfg.smlotMigMinAgeMin,
      MAX_AGE_MIN: cfg.smlotMigMaxAgeMin,
    };
  }
  return {
    MIN_LIQ_USD: cfg.smlotPostMinLiqUsd,
    MAX_LIQ_USD: cfg.smlotPostMaxLiqUsd,
    MIN_VOL_5M_USD: cfg.smlotPostMinVol5mUsd,
    MAX_VOL_5M_USD: 0,
    MIN_BUYS_5M: cfg.smlotPostMinBuys5m,
    MIN_SELLS_5M: cfg.smlotPostMinSells5m,
    MIN_AGE_MIN: cfg.smlotPostMinAgeMin,
    MAX_AGE_MIN: cfg.smlotPostMaxAgeMin,
  };
}

export function laneCfg(cfg: PaperTraderConfig, lane: Lane): LaneCfg {
  if (lane === 'migration_event') {
    return {
      MIN_LIQ_USD: cfg.laneMigMinLiqUsd,
      MAX_LIQ_USD: cfg.laneMigMaxLiqUsd,
      MIN_VOL_5M_USD: cfg.laneMigMinVol5mUsd,
      MAX_VOL_5M_USD: 0,
      MIN_BUYS_5M: cfg.laneMigMinBuys5m,
      MIN_SELLS_5M: cfg.laneMigMinSells5m,
      MIN_AGE_MIN: cfg.laneMigMinAgeMin,
      MAX_AGE_MIN: cfg.laneMigMaxAgeMin,
    };
  }
  return {
    MIN_LIQ_USD: cfg.lanePostMinLiqUsd,
    MAX_LIQ_USD: cfg.lanePostMaxLiqUsd,
    MIN_VOL_5M_USD: cfg.lanePostMinVol5mUsd,
    MAX_VOL_5M_USD: cfg.lanePostMaxVol5mUsd,
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
  const vol1hMax = cfg.vol1hMaxUsd ?? 0;
  if (vol1hMax > 0 && vol1h > vol1hMax) {
    return { pass: false, reasons: [`vol1h>${vol1hMax}`] };
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
  if (lc.MAX_LIQ_USD > 0 && row.liquidity_usd > lc.MAX_LIQ_USD) {
    reasons.push(`liq>${lc.MAX_LIQ_USD}`);
  }
  if (row.volume_5m < lc.MIN_VOL_5M_USD) reasons.push(`vol5m<${lc.MIN_VOL_5M_USD}`);
  if (lc.MAX_VOL_5M_USD > 0 && row.volume_5m > lc.MAX_VOL_5M_USD) {
    reasons.push(`vol5m>${lc.MAX_VOL_5M_USD}`);
  }
  if (row.buys_5m < lc.MIN_BUYS_5M) reasons.push(`buys5m<${lc.MIN_BUYS_5M}`);
  if (row.sells_5m < lc.MIN_SELLS_5M) reasons.push(`sells5m<${lc.MIN_SELLS_5M}`);
  const bs = row.sells_5m > 0 ? row.buys_5m / row.sells_5m : row.buys_5m;
  if (bs < cfg.snapshotMinBs) reasons.push(`bs<${cfg.snapshotMinBs}`);
  const vh = evaluateVol5m1hGuard(cfg, row);
  if (!vh.pass) reasons.push(...vh.reasons);
  const minMcap = cfg.discoveryMinMarketCapUsd ?? 0;
  if (minMcap > 0) {
    const refMcap = snapshotRefMarketCapUsd(row);
    if (refMcap + 1e-9 < minMcap) reasons.push(`mcap<${minMcap}`);
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * Priority dip-watch tier: liq/mcap/vol1h/bs без vol5m/buys/sells floor — ловим тихие проливы.
 */
export function evaluateSnapshotPriorityTier(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  lane: Lane,
): { pass: boolean; reasons: string[] } {
  const lc = laneCfg(cfg, lane);
  const reasons: string[] = [];
  if (row.liquidity_usd < lc.MIN_LIQ_USD) reasons.push(`liq<${lc.MIN_LIQ_USD}`);
  if (lc.MAX_LIQ_USD > 0 && row.liquidity_usd > lc.MAX_LIQ_USD) {
    reasons.push(`liq>${lc.MAX_LIQ_USD}`);
  }
  const bs = row.sells_5m > 0 ? row.buys_5m / row.sells_5m : row.buys_5m;
  if (bs < cfg.priorityDiscoveryMinBs) reasons.push(`bs<${cfg.priorityDiscoveryMinBs}`);
  const vol1h = Number(row.volume_1h ?? 0);
  if (cfg.vol5m1hGuardEnabled) {
    if (!Number.isFinite(vol1h) || vol1h <= 0) reasons.push('vol1h_missing');
    else if (vol1h < cfg.vol1hMinUsd) reasons.push(`vol1h<${cfg.vol1hMinUsd}`);
  }
  const minMcap = cfg.discoveryMinMarketCapUsd ?? 0;
  if (minMcap > 0) {
    const refMcap = snapshotRefMarketCapUsd(row);
    if (refMcap + 1e-9 < minMcap) reasons.push(`mcap<${minMcap}`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** Snapshot lane gate for `smart_lottery` — uses `smartLotteryLaneCfg`, shared BS + vol5m/1h guard. */
export function evaluateSnapshotSmartLottery(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  lane: Lane,
): { pass: boolean; reasons: string[] } {
  const lc = smartLotteryLaneCfg(cfg, lane);
  const reasons: string[] = [];
  if (row.liquidity_usd < lc.MIN_LIQ_USD) reasons.push(`liq<${lc.MIN_LIQ_USD}`);
  if (lc.MAX_LIQ_USD > 0 && row.liquidity_usd > lc.MAX_LIQ_USD) {
    reasons.push(`liq>${lc.MAX_LIQ_USD}`);
  }
  if (row.volume_5m < lc.MIN_VOL_5M_USD) reasons.push(`vol5m<${lc.MIN_VOL_5M_USD}`);
  if (lc.MAX_VOL_5M_USD > 0 && row.volume_5m > lc.MAX_VOL_5M_USD) {
    reasons.push(`vol5m>${lc.MAX_VOL_5M_USD}`);
  }
  if (row.buys_5m < lc.MIN_BUYS_5M) reasons.push(`buys5m<${lc.MIN_BUYS_5M}`);
  if (row.sells_5m < lc.MIN_SELLS_5M) reasons.push(`sells5m<${lc.MIN_SELLS_5M}`);
  const bs = row.sells_5m > 0 ? row.buys_5m / row.sells_5m : row.buys_5m;
  if (bs < cfg.snapshotMinBs) reasons.push(`bs<${cfg.snapshotMinBs}`);
  const vh = evaluateVol5m1hGuard(cfg, row);
  if (!vh.pass) reasons.push(...vh.reasons);
  const minMcap = cfg.discoveryMinMarketCapUsd ?? 0;
  if (minMcap > 0) {
    const refMcap = snapshotRefMarketCapUsd(row);
    if (refMcap + 1e-9 < minMcap) reasons.push(`mcap<${minMcap}`);
  }
  return { pass: reasons.length === 0, reasons };
}

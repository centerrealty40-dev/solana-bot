/**
 * Live vol5m/vol1h spread checks тАФ shared by sybil + ephemeral guards.
 * When Birdeye/DexScreener overlay fresh volume on evalRow, these use REST not PG.
 */
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';

export function vol5mToVol1hRatio(
  row: Pick<SnapshotCandidateRow, 'volume_5m' | 'volume_1h'>,
): number | null {
  const vol1h = Number(row.volume_1h ?? 0);
  const vol5m = Number(row.volume_5m ?? 0);
  if (!(vol1h > 0) || !(vol5m >= 0)) return null;
  return +(vol5m / vol1h).toFixed(4);
}

/** True when live vol5m and vol1h show sustained activity, not tail-wash (dead vol5m + inflated vol1h). */
export function isHealthyLiveVolumeSpread(
  cfg: PaperTraderConfig,
  row: Pick<SnapshotCandidateRow, 'volume_5m' | 'volume_1h'>,
): boolean {
  const vol1h = Number(row.volume_1h ?? 0);
  const vol5m = Number(row.volume_5m ?? 0);
  if (!Number.isFinite(vol1h) || vol1h < cfg.volumeGuardNewMintVol1hWashMinUsd) return false;
  const ratio = vol5mToVol1hRatio(row);
  if (ratio == null || ratio < cfg.volumeGuardNewMintMinVol5mToVol1hRatio) return false;
  if (!Number.isFinite(vol5m) || vol5m < cfg.volumeEphemeralMinActiveHourVol5mUsd) return false;
  return true;
}


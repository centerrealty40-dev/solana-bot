/**
 * Step 3 — Jupiter spot cross-check for volume-leader tier mints.
 * Корректирует price/mcap in-memory когда PG snapshot расходится с tradable quote.
 */
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import {
  refreshRowsPricesFromJupiter,
  type JupiterSpotRefreshResult,
} from './jupiter-spot-refresh.js';

export function jupiterCrossCheckDivergenceOk(
  snapshotPx: number,
  jupiterPx: number,
  minPct: number,
  maxPct: number,
): boolean {
  if (!(snapshotPx > 0 && jupiterPx > 0)) return false;
  const divPct = (Math.abs(jupiterPx - snapshotPx) / snapshotPx) * 100;
  if (minPct > 0 && divPct + 1e-12 < minPct) return false;
  if (maxPct > 0 && divPct > maxPct + 1e-12) return false;
  return true;
}

export type VolumeLeaderJupiterCrossCheckResult = JupiterSpotRefreshResult & {
  refreshedMints: Set<string>;
};

/**
 * Dedicated Jupiter refresh budget for volume-leader mints (before priority refresh).
 * Не требует `PAPER_PRIORITY_DISCOVERY_JUPITER_REFRESH` — свой флаг tier'а.
 */
export async function crossCheckVolumeLeaderSnapshotsFromJupiter(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
  volumeLeaderMintSet: ReadonlySet<string>,
): Promise<VolumeLeaderJupiterCrossCheckResult> {
  const empty: VolumeLeaderJupiterCrossCheckResult = {
    refreshed: 0,
    skipped: 0,
    errors: 0,
    refreshedMints: new Set(),
  };
  if (
    !cfg.volumeLeaderEnabled ||
    !cfg.volumeLeaderJupiterCrossCheckEnabled ||
    volumeLeaderMintSet.size === 0
  ) {
    return empty;
  }

  const refreshedMints = new Set<string>();
  const sorted = [...rows].sort((a, b) => {
    const av = volumeLeaderMintSet.has(a.mint) ? 0 : 1;
    const bv = volumeLeaderMintSet.has(b.mint) ? 0 : 1;
    return av - bv;
  });

  const result = await refreshRowsPricesFromJupiter(
    cfg,
    sorted,
    (row) => volumeLeaderMintSet.has(row.mint),
    cfg.volumeLeaderJupiterCrossCheckMaxPerTick,
    {
      bypassPriorityJupiterGate: true,
      minApplyDivergencePct: cfg.volumeLeaderJupiterCrossCheckMinDivergencePct,
      maxApplyDivergencePct: cfg.volumeLeaderJupiterCrossCheckMaxDivergencePct,
      onApplied: (row) => refreshedMints.add(row.mint),
    },
  );

  return { ...result, refreshedMints };
}
